import { MercadoLivreApiError } from "@sb/mercado-livre";
import { z } from "zod";

import type { Enqueuer } from "../enqueue.js";
import type { JobOutcome } from "../job-outcome.js";
import { readAllPages } from "../read-all-pages.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { ensureAccessToken } from "./ml-token.js";
import { capturarCustosDosPedidos, type OrderToSweep, type SyncOrderFinancialsDeps } from "./sync-order-financials.js";
import { recordSyncRunFailure, recordSyncRunSuccess } from "./sync-runs.js";

/**
 * `backfill.order-financials` (D-396) — recupera o frete do vendedor (e o
 * desconto) dos pedidos ANTERIORES à janela da varredura diária.
 *
 * D-165 decidiu "sem backfill além da janela": o frete só é capturado a
 * partir do dia em que a captura começou, e em produção isso é 14/09/2026. A
 * Central do negócio (D-394/D-395) mostrou o custo disso — resultado, margem
 * e lucro sobre ~30% da receita de 30 dias, e o Ads rateado por essa
 * cobertura. O dono pediu 90 dias.
 *
 * **O desenho é o de `backfill.orders`:**
 *
 * - fila `backfill` (1/s, 2 simultâneas), nunca a fila da conta — a
 *   sincronização em tempo real não disputa com a história;
 * - pedaço de UM DIA por execução: a maior conta vende ~330 pedidos por dia,
 *   duas chamadas por pedido com 150 ms entre pedidos → ~4 min, folgado no
 *   timeout de 15 min do worker;
 * - cada pedaço, ao terminar, enfileira o dia ANTERIOR até o limite. Uma
 *   conta nunca tem dois pedaços ao mesmo tempo, e o rate limit por conta é o
 *   mesmo da varredura diária;
 * - progresso por EXISTÊNCIA de linha (D-156): repetir um pedaço pula o que
 *   já foi gravado, e pedidos que a varredura diária já capturou também.
 *
 * O laço de captura é o mesmo da varredura (`capturarCustosDosPedidos`): 4xx
 * definitivo grava NULL ("não observado", nunca zero), resposta fora do
 * contrato não grava e é contada.
 */

const payloadSchema = z.object({
  mlAccountId: z.uuid(),
  /** Fim do pedaço, exclusivo. */
  ate: z.iso.datetime(),
  /** Até onde a recuperação desce; o último pedaço para aqui. */
  limite: z.iso.datetime(),
});

/** Um dia por execução (ver o cabeçalho). */
const PEDACO_MS = 24 * 3_600_000;

/** `order_financials` é consultada pelos ids do pedaço em lotes: a URL do PostgREST tem teto. */
const LOTE_DE_IDS = 200;

export interface BackfillOrderFinancialsDeps extends SyncOrderFinancialsDeps {
  enqueuer: Enqueuer;
}

export function createBackfillOrderFinancialsHandler(deps: BackfillOrderFinancialsDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem mlAccountId, ate ou limite" };
    }

    const { mlAccountId } = parsed.data;
    const ate = new Date(parsed.data.ate);
    const limite = new Date(parsed.data.limite);
    const now = deps.now?.() ?? new Date();

    if (ate.getTime() <= limite.getTime()) {
      context.logger.info("backfill_order_financials_complete", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    const account = await deps.db
      .from("ml_accounts")
      .select("id, organization_id, slug, status")
      .eq("id", mlAccountId)
      .maybeSingle();

    if (account.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao ler a conta: ${account.error.message}` };
    }

    if (account.data?.status !== "CONNECTED") {
      // Desconectada entre um pedaço e outro: a corrente para aqui, sem erro.
      // Um novo disparo retoma — o que já foi gravado é pulado.
      context.logger.info("backfill_order_financials_account_not_connected", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    const { organization_id: organizationId, slug } = account.data;
    const desde = new Date(Math.max(ate.getTime() - PEDACO_MS, limite.getTime()));
    const started = now;
    const tokenResult = await ensureAccessToken(deps, mlAccountId, now);

    if (!tokenResult.ok) {
      await recordSyncRunFailure(
        deps.db,
        {
          organizationId,
          mlAccountId,
          jobId: envelope.jobId,
          resource: "order_financials",
          channel: "backfill",
          startedAt: started,
          finishedAt: deps.now?.() ?? new Date(),
          reason: tokenResult.reason,
          errorClass: tokenResult.retryable ? "retryable" : "not_retryable",
        },
        context.logger,
      );

      return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
    }

    // Paginado (classe D-131): um dia de uma conta cabe em uma página hoje,
    // mas o teto do PostgREST não pode virar o total da recuperação.
    const orders = await readAllPages<OrderToSweep>(
      (from, to) =>
        deps.db
          .from("orders")
          .select("id, shipping_id")
          .eq("ml_account_id", mlAccountId)
          .in("status", ["paid", "partially_refunded"])
          .gte("date_created", desde.toISOString())
          .lt("date_created", ate.toISOString())
          .order("id")
          .range(from, to),
      { label: "falha ao ler orders do pedaço" },
    );

    const alreadyCaptured = new Set<number>();

    for (let i = 0; i < orders.length; i += LOTE_DE_IDS) {
      const ids = orders.slice(i, i + LOTE_DE_IDS).map((order) => order.id);
      const lidos = await deps.db.from("order_financials").select("order_id").in("order_id", ids);

      if (lidos.error !== null) {
        return { status: "failed", retryable: true, reason: `falha ao ler o checkpoint: ${lidos.error.message}` };
      }

      for (const row of lidos.data) alreadyCaptured.add(row.order_id);
    }

    let resultado;

    try {
      resultado = await capturarCustosDosPedidos({
        deps,
        context,
        mlAccountId,
        organizationId,
        accessToken: tokenResult.accessToken,
        orders,
        alreadyCaptured,
      });
    } catch (error) {
      const finishedAt = deps.now?.() ?? new Date();
      const errorClass = error instanceof MercadoLivreApiError ? error.errorClass : "retryable";
      const reason = error instanceof Error ? error.message : "erro desconhecido na recuperação de custos";

      await recordSyncRunFailure(
        deps.db,
        {
          organizationId,
          mlAccountId,
          jobId: envelope.jobId,
          resource: "order_financials",
          channel: "backfill",
          startedAt: started,
          finishedAt,
          reason,
          errorClass,
        },
        context.logger,
      );

      // O Cloud Tasks repete O MESMO pedaço; o que já foi gravado é pulado.
      return { status: "failed", retryable: errorClass !== "not_retryable", reason };
    }

    const finishedAt = deps.now?.() ?? new Date();
    const foraDoContrato =
      resultado.itemsShapeUnknown > 0
        ? `${String(resultado.itemsShapeUnknown)} pedido(s) com resposta fora do contrato do Mercado Livre; não gravados`
        : undefined;

    await recordSyncRunSuccess(
      deps.db,
      {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        resource: "order_financials",
        channel: "backfill",
        itemsProcessed: resultado.itemsProcessed,
        latestRecordAt: finishedAt,
        startedAt: started,
        finishedAt,
        status: resultado.itemsShapeUnknown > 0 ? "partial" : "done",
        ...(foraDoContrato !== undefined ? { reason: foraDoContrato } : {}),
      },
      context.logger,
    );

    const temMais = desde.getTime() > limite.getTime();

    if (temMais) {
      await deps.enqueuer.enqueue({
        jobType: "backfill.order-financials",
        organizationId,
        dedupeKey: `backfill-order-financials:${slug}:${desde.toISOString()}`,
        queue: "backfill",
        payload: { mlAccountId, ate: desde.toISOString(), limite: limite.toISOString() },
      });
    }

    context.logger.info("backfill_order_financials_chunk_done", {
      ml_account_id: mlAccountId,
      desde: desde.toISOString(),
      ate: ate.toISOString(),
      pedidos: orders.length,
      items_processed: resultado.itemsProcessed,
      items_skipped: resultado.itemsSkipped,
      items_without_shipping: resultado.itemsWithoutShipping,
      items_shape_unknown: resultado.itemsShapeUnknown,
      tem_mais: temMais,
    });

    return { status: "done", processed: resultado.itemsProcessed };
  };
}
