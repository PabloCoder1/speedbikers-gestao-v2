import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { ceilToHour, fetchOrdersWindow, floorToHour } from "./ml-orders-fetch.js";
import { ensureAccessToken } from "./ml-token.js";
import { recordSyncRunFailure, recordSyncRunSuccess } from "./sync-runs.js";

/**
 * Reconciliação por janela: rede de segurança do que o webhook perdeu
 * (`docs/MERCADO_LIVRE.md` secao 3, `docs/ARCHITECTURE.md` secao 10).
 *
 * Escopo desta etapa: buscar a janela no Mercado Livre e registrar o
 * resultado em `sync_runs`/`sync_errors` — a persistência estruturada dos
 * pedidos (`orders`/`order_items`, `pack_id`) é o PRÓXIMO item do checklist
 * da Fase 3, feito de propósito à parte (mesmo padrão incremental de
 * "schema primeiro, escrita depois" já usado em `sync_runs` na Fase 2).
 */

const payloadSchema = z.object({ mlAccountId: z.uuid() });

export interface SyncOrdersWindowDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
}

/**
 * Checkpoint entre execuções: `latest_record_at` (ou, se a última execução
 * não trouxe nada novo, `started_at` dela — perder zero é seguro) da última
 * `sync_run` bem-sucedida deste recurso e canal. Primeira execução usa
 * `connected_at` como piso. Nunca offset persistido (`docs/MERCADO_LIVRE.md`
 * secao 4).
 */
async function resolveWindowFrom(
  db: AdminClient,
  mlAccountId: string,
  connectedAt: string | null,
  now: Date,
): Promise<Date> {
  const lastRun = await db
    .from("sync_runs")
    .select("latest_record_at, started_at")
    .eq("ml_account_id", mlAccountId)
    .eq("resource", "orders")
    .eq("channel", "reconciliation")
    .in("status", ["done", "partial"])
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastRun.data !== null) {
    return floorToHour(new Date(lastRun.data.latest_record_at ?? lastRun.data.started_at));
  }

  const fallback = connectedAt ?? new Date(now.getTime() - 24 * 3_600_000).toISOString();

  return floorToHour(new Date(fallback));
}

export function createSyncOrdersWindowHandler(deps: SyncOrdersWindowDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem mlAccountId" };
    }

    const { mlAccountId } = parsed.data;
    const now = deps.now?.() ?? new Date();

    const account = await deps.db
      .from("ml_accounts")
      .select("id, organization_id, seller_id, status, connected_at")
      .eq("id", mlAccountId)
      .maybeSingle();

    if (account.error !== null || account.data === null) {
      context.logger.warn("sync_orders_window_account_missing", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    if (account.data.status !== "CONNECTED" || account.data.seller_id === null) {
      // Desconectada entre o enfileiramento e a execução — corrida benigna,
      // não erro. A próxima janela, se a conta reconectar, cobre o intervalo.
      context.logger.info("sync_orders_window_account_not_connected", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    // Copiados para variáveis locais logo após a guarda: acesso repetido a
    // `account.data.seller_id` dentro do closure de `fetchOrdersWindow`,
    // abaixo, não preserva o estreitamento de tipo do `if` acima.
    const { organization_id: organizationId, seller_id: sellerId, connected_at: connectedAt } = account.data;

    const started = now;
    const tokenResult = await ensureAccessToken(deps, mlAccountId, now);

    if (!tokenResult.ok) {
      await recordSyncRunFailure(deps.db, {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        resource: "orders",
        channel: "reconciliation",
        startedAt: started,
        finishedAt: deps.now?.() ?? new Date(),
        reason: tokenResult.reason,
        errorClass: tokenResult.retryable ? "retryable" : "not_retryable",
      });

      return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
    }

    const windowFrom = await resolveWindowFrom(deps.db, mlAccountId, connectedAt, now);
    const windowTo = ceilToHour(now);

    let result;

    try {
      result = await fetchOrdersWindow({
        db: deps.db,
        organizationId,
        mlAccountId,
        mercadoLivre: deps.mercadoLivre,
        accessToken: tokenResult.accessToken,
        sellerId,
        from: windowFrom,
        to: windowTo,
        logger: context.logger,
      });
    } catch (error) {
      const finishedAt = deps.now?.() ?? new Date();
      const errorClass = error instanceof MercadoLivreApiError ? error.errorClass : "retryable";
      const reason = error instanceof Error ? error.message : "erro desconhecido ao buscar pedidos";

      await recordSyncRunFailure(deps.db, {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        resource: "orders",
        channel: "reconciliation",
        startedAt: started,
        finishedAt,
        reason,
        errorClass,
      });

      return { status: "failed", retryable: errorClass !== "not_retryable", reason };
    }

    const finishedAt = deps.now?.() ?? new Date();
    const partial = result.itemsSkipped > 0;

    await recordSyncRunSuccess(deps.db, {
      organizationId,
      mlAccountId,
      jobId: envelope.jobId,
      resource: "orders",
      channel: "reconciliation",
      itemsProcessed: result.itemsProcessed,
      latestRecordAt: result.latestRecordAt,
      startedAt: started,
      finishedAt,
      status: partial ? "partial" : "done",
      ...(partial
        ? { reason: `${String(result.itemsSkipped)} order(s) com formato inesperado, ignoradas` }
        : {}),
    });

    context.logger.info("sync_orders_window_done", {
      ml_account_id: mlAccountId,
      window_from: windowFrom.toISOString(),
      window_to: windowTo.toISOString(),
      items_processed: result.itemsProcessed,
      items_skipped: result.itemsSkipped,
    });

    return { status: "done", processed: result.itemsProcessed };
  };
}
