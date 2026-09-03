import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { z, ZodError } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import { readAllPages } from "../read-all-pages.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { ensureAccessToken } from "./ml-token.js";
import { recordSyncRunFailure, recordSyncRunSuccess } from "./sync-runs.js";

/**
 * `sync.order-financials` (D-165) — captura, por conta, os dois custos que
 * bloqueavam a margem operacional (`docs/METRICS.md` 5C.2):
 *
 *   frete do vendedor   = soma de `senders[].cost` em GET /shipments/{id}/costs
 *   desconto do vendedor = `amounts.seller`        em GET /orders/{id}/discounts
 *
 * Fontes confirmadas na leitura oficial de §2.15 (D-120). Duas honestidades
 * de desenho:
 *
 * 1. **NULL nunca vira zero**: endpoint que responde 4xx definitivo para um
 *    pedido (sem envio, sem desconto observável) grava o campo NULO — a
 *    linha existe (o pedido FOI varrido), o valor não foi observado. Zero
 *    afirmaria "custou R$ 0,00", que a doc não sustenta.
 * 2. **Pedido sem `shipping_id` é declarado, não escondido**: pedidos
 *    persistidos antes de D-165 não têm a chave do frete. Eles entram na
 *    varredura (o desconto não depende do shipping) com o frete NULO e
 *    saem na contagem `items_without_shipping` do log.
 *
 * Progresso por EXISTÊNCIA DE LINHA (a lição de D-156): cada tentativa do
 * Cloud Tasks pula o que já foi capturado — 429 esgotado no meio da lista
 * não descarta o que veio antes. Espaçamento entre pedidos pela mesma razão.
 */

const payloadSchema = z.object({ mlAccountId: z.uuid() });

/** GET /shipments/{id}/costs — só o que a conciliação usa (§2.15). */
const shipmentCostsSchema = z.object({
  senders: z.array(z.object({ cost: z.number().nonnegative() })),
});

/**
 * GET /orders/{id}/discounts — a forma DOCUMENTADA (D-229) é uma lista:
 *
 *   { details: [ { type, items: [ { id, quantity, amounts: { total, seller } } ] } ] }
 *
 * `amounts.seller` existe, mas DENTRO de cada item de cada desconto — nunca
 * na raiz. D-165 leu "`amounts.seller` em GET /orders/{id}/discounts" da
 * tabela de §2.15 e escreveu o schema com `amounts` na raiz; em produção,
 * TODA resposta real falhava na validação (16 execuções em 03/09/2026, uma
 * linha gravada — a única cujo endpoint respondeu 4xx). A forma antiga
 * continua aceita na união: nada prova que o Mercado Livre nunca a devolve,
 * e aceitar as duas custa uma linha.
 *
 * O desconto do vendedor é a SOMA de `amounts.seller` sobre todos os itens
 * de todos os descontos. `details` VAZIO é desconto ZERO observado — o
 * endpoint enumerou os descontos do pedido e não havia nenhum — distinto do
 * 4xx definitivo, que continua NULL ("não observado").
 */
const orderDiscountsSchema = z.union([
  z.object({
    details: z.array(
      z.object({
        items: z.array(z.object({ amounts: z.object({ seller: z.number().nonnegative() }) })),
      }),
    ),
  }),
  z.object({ amounts: z.object({ seller: z.number().nonnegative() }) }),
]);

type OrderDiscounts = z.infer<typeof orderDiscountsSchema>;

function sumSellerDiscount(payload: OrderDiscounts): number {
  if ("details" in payload) {
    return payload.details.reduce(
      (total, detail) => total + detail.items.reduce((sub, item) => sub + item.amounts.seller, 0),
      0,
    );
  }

  return payload.amounts.seller;
}

/** Janela da varredura: pedidos válidos dos últimos N dias sem captura. */
const SWEEP_WINDOW_DAYS = 7;

/** ~6-7 chamadas/s no pior caso — mesmo valor medido/aceito em D-156. */
const INTER_ORDER_DELAY_MS = 150;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SyncOrderFinancialsDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface OrderToSweep {
  id: number;
  shipping_id: number | null;
}

/**
 * Busca um custo remoto tolerando 4xx definitivo como "não observado".
 * Retryable (429/5xx) propaga — a fila re-tenta e o progresso já gravado
 * não se repete.
 */
async function fetchOptionalCost<T>(
  request: () => Promise<T>,
  extract: (payload: T) => number,
): Promise<number | null> {
  try {
    return extract(await request());
  } catch (error) {
    if (error instanceof MercadoLivreApiError && error.errorClass === "not_retryable") {
      return null;
    }

    throw error;
  }
}

export function createSyncOrderFinancialsHandler(deps: SyncOrderFinancialsDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem mlAccountId" };
    }

    const { mlAccountId } = parsed.data;
    const now = deps.now?.() ?? new Date();
    const sleep = deps.sleep ?? defaultSleep;

    const account = await deps.db
      .from("ml_accounts")
      .select("id, organization_id, status")
      .eq("id", mlAccountId)
      .maybeSingle();

    if (account.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao ler a conta: ${account.error.message}` };
    }

    if (account.data?.status !== "CONNECTED") {
      context.logger.info("sync_order_financials_account_not_connected", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    const organizationId = account.data.organization_id;
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
          channel: "reconciliation",
          startedAt: started,
          finishedAt: deps.now?.() ?? new Date(),
          reason: tokenResult.reason,
          errorClass: tokenResult.retryable ? "retryable" : "not_retryable",
        },
        context.logger,
      );

      return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
    }

    const accessToken = tokenResult.accessToken;
    const windowStart = new Date(now.getTime() - SWEEP_WINDOW_DAYS * 86_400_000).toISOString();

    // Paginado (classe D-131): janela de 7 dias já passa de 1.000 pedidos
    // por conta em semana forte. `id` é único — ordenação estável.
    const orders = await readAllPages<OrderToSweep>(
      (from, to) =>
        deps.db
          .from("orders")
          .select("id, shipping_id")
          .eq("ml_account_id", mlAccountId)
          .in("status", ["paid", "partially_refunded"])
          .gte("date_created", windowStart)
          .order("id")
          .range(from, to),
      { label: "falha ao ler orders" },
    );

    const captured = await readAllPages<{ order_id: number }>(
      (from, to) =>
        deps.db
          .from("order_financials")
          .select("order_id")
          .eq("ml_account_id", mlAccountId)
          .gte("captured_at", windowStart)
          .order("order_id")
          .range(from, to),
      { label: "falha ao ler o checkpoint de order_financials" },
    );

    // A linha pode ter sido capturada ANTES da janela (pedido antigo varrido
    // numa rodada anterior) — o filtro por captured_at acima é só para não
    // paginar a tabela inteira; o Set decide por pedido.
    const alreadyCaptured = new Set(captured.map((row) => row.order_id));

    let itemsProcessed = 0;
    let itemsSkipped = 0;
    let itemsWithoutShipping = 0;
    let itemsShapeUnknown = 0;
    let requestsMade = 0;

    try {
      for (const order of orders) {
        if (alreadyCaptured.has(order.id)) {
          itemsSkipped += 1;

          continue;
        }

        if (requestsMade > 0) {
          await sleep(INTER_ORDER_DELAY_MS);
        }

        requestsMade += 1;

        let shippingCost: number | null = null;
        let sellerDiscount: number | null = null;

        try {
          if (order.shipping_id === null) {
            itemsWithoutShipping += 1;
          } else {
            shippingCost = await fetchOptionalCost(
              () =>
                deps.mercadoLivre.request({
                  method: "GET",
                  path: `/shipments/${String(order.shipping_id)}/costs`,
                  accessToken,
                  schema: shipmentCostsSchema,
                }),
              (payload) => payload.senders.reduce((total, sender) => total + sender.cost, 0),
            );
          }

          sellerDiscount = await fetchOptionalCost(
            () =>
              deps.mercadoLivre.request({
                method: "GET",
                path: `/orders/${String(order.id)}/discounts`,
                accessToken,
                schema: orderDiscountsSchema,
              }),
            sumSellerDiscount,
          );
        } catch (error) {
          // Resposta 200 FORA do contrato (D-229). O cliente HTTP valida com
          // `schema.parse` e deixa o ZodError cru propagar; até aqui ele caía
          // no catch de fora como "retryable", o Cloud Tasks repetia 8 vezes
          // e o dia inteiro da conta morria no primeiro pedido cuja resposta o
          // schema não conhecia — nenhuma repetição muda o corpo que o
          // Mercado Livre devolve. É falha PERMANENTE deste pedido, não da
          // varredura: registra, pula SEM gravar linha (sem checkpoint, ele
          // volta amanhã e é capturado quando o schema for corrigido) e
          // segue para o próximo. Gravar NULL aqui queimaria o pedido para
          // sempre (D-156: progresso por existência de linha).
          if (error instanceof ZodError) {
            itemsShapeUnknown += 1;
            context.logger.warn("sync_order_financials_shape_unknown", {
              ml_account_id: mlAccountId,
              order_id: order.id,
              issues: error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`),
            });

            continue;
          }

          throw error;
        }

        const inserted = await deps.db.from("order_financials").upsert(
          {
            order_id: order.id,
            organization_id: organizationId,
            ml_account_id: mlAccountId,
            seller_shipping_cost: shippingCost,
            seller_discount: sellerDiscount,
            captured_at: (deps.now?.() ?? new Date()).toISOString(),
          },
          { onConflict: "order_id", ignoreDuplicates: true },
        );

        if (inserted.error !== null) {
          throw new Error(`falha ao gravar order_financials: ${inserted.error.message}`);
        }

        itemsProcessed += 1;
      }
    } catch (error) {
      // Retryable no meio da lista: o progresso já persistiu; a próxima
      // tentativa pula pelo checkpoint. Registrar a falha com honestidade.
      const finishedAt = deps.now?.() ?? new Date();
      const errorClass = error instanceof MercadoLivreApiError ? error.errorClass : "retryable";
      const reason = error instanceof Error ? error.message : "erro desconhecido na varredura de custos";

      await recordSyncRunFailure(
        deps.db,
        {
          organizationId,
          mlAccountId,
          jobId: envelope.jobId,
          resource: "order_financials",
          channel: "reconciliation",
          startedAt: started,
          finishedAt,
          reason,
          errorClass,
        },
        context.logger,
      );

      return { status: "failed", retryable: errorClass !== "not_retryable", reason };
    }

    const finishedAt = deps.now?.() ?? new Date();

    // `partial` quando algum pedido ficou fora do contrato: o trabalho que
    // deu para fazer foi feito e persistiu, mas /saude precisa ver que a
    // varredura não está inteira — um log que ninguém lê não basta (D-208).
    const shapeUnknownReason =
      itemsShapeUnknown > 0
        ? `${String(itemsShapeUnknown)} pedido(s) com resposta fora do contrato do Mercado Livre; não gravados, voltam na próxima varredura`
        : undefined;

    await recordSyncRunSuccess(
      deps.db,
      {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        resource: "order_financials",
        channel: "reconciliation",
        itemsProcessed,
        latestRecordAt: finishedAt,
        startedAt: started,
        finishedAt,
        status: itemsShapeUnknown > 0 ? "partial" : "done",
        ...(shapeUnknownReason !== undefined ? { reason: shapeUnknownReason } : {}),
      },
      context.logger,
    );

    context.logger.info("sync_order_financials_done", {
      ml_account_id: mlAccountId,
      items_processed: itemsProcessed,
      items_skipped: itemsSkipped,
      // Pedidos anteriores a D-165 (sem shipping_id): frete fica NULO,
      // declarado — nunca escondido na média.
      items_without_shipping: itemsWithoutShipping,
      items_shape_unknown: itemsShapeUnknown,
    });

    return { status: "done", processed: itemsProcessed };
  };
}
