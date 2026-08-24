import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { fetchFulfillmentSnapshots } from "./ml-fulfillment-fetch.js";
import { ensureAccessToken } from "./ml-token.js";
import { recordSyncRunFailure, recordSyncRunSuccess } from "./sync-runs.js";

/**
 * `sync.fulfillment.snapshot` — captura do estoque Full por conta
 * (`docs/ROADMAP.md`, Fase 4). Mesmo formato de `sync.orders.window`: uma
 * varredura completa por execução, não incremental — Full não tem um
 * "checkpoint" natural como `date_last_updated` de pedidos, é sempre uma
 * fotografia do estado atual de cada item.
 *
 * `resource: "fulfillment"` já estava previsto no CHECK de `sync_runs`
 * desde a migration de observabilidade da Fase 2 — esta é a primeira etapa
 * a de fato usá-lo.
 */

const payloadSchema = z.object({ mlAccountId: z.uuid() });

export interface SyncFulfillmentSnapshotDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
}

export function createSyncFulfillmentSnapshotHandler(deps: SyncFulfillmentSnapshotDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem mlAccountId" };
    }

    const { mlAccountId } = parsed.data;
    const now = deps.now?.() ?? new Date();

    const account = await deps.db
      .from("ml_accounts")
      .select("id, organization_id, status")
      .eq("id", mlAccountId)
      .maybeSingle();

    if (account.error !== null || account.data === null) {
      context.logger.warn("sync_fulfillment_snapshot_account_missing", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    if (account.data.status !== "CONNECTED") {
      // Desconectada entre o enfileiramento e a execução — corrida benigna,
      // mesmo tratamento de sync.orders.window.
      context.logger.info("sync_fulfillment_snapshot_account_not_connected", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    const { organization_id: organizationId } = account.data;
    const started = now;
    const tokenResult = await ensureAccessToken(deps, mlAccountId, now);

    if (!tokenResult.ok) {
      await recordSyncRunFailure(deps.db, {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        resource: "fulfillment",
        channel: "reconciliation",
        startedAt: started,
        finishedAt: deps.now?.() ?? new Date(),
        reason: tokenResult.reason,
        errorClass: tokenResult.retryable ? "retryable" : "not_retryable",
      }, context.logger);

      return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
    }

    let result;

    try {
      result = await fetchFulfillmentSnapshots({
        db: deps.db,
        organizationId,
        mlAccountId,
        mercadoLivre: deps.mercadoLivre,
        accessToken: tokenResult.accessToken,
        logger: context.logger,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      });
    } catch (error) {
      const finishedAt = deps.now?.() ?? new Date();
      const errorClass = error instanceof MercadoLivreApiError ? error.errorClass : "retryable";
      const reason = error instanceof Error ? error.message : "erro desconhecido ao capturar estoque Full";

      await recordSyncRunFailure(deps.db, {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        resource: "fulfillment",
        channel: "reconciliation",
        startedAt: started,
        finishedAt,
        reason,
        errorClass,
      }, context.logger);

      return { status: "failed", retryable: errorClass !== "not_retryable", reason };
    }

    const finishedAt = deps.now?.() ?? new Date();
    const partial = result.itemsFailed > 0;

    // `itemsSkipped` (item sem `inventory_id`, nunca foi ao Full) NÃO é
    // "partial" — diferente de sync.orders.window, onde uma order de
    // formato inesperado é um problema de dado. É o estado normal e
    // esperado de qualquer vendedor que não manda 100% do catálogo pro
    // Full. `itemsFailed` (404/403 do Mercado Livre — achado em produção:
    // vínculo apontando pra anúncio removido/pausado) É um sinal real de
    // dado desatualizado, marca `partial` como o resto do sistema já faz.
    await recordSyncRunSuccess(deps.db, {
      organizationId,
      mlAccountId,
      jobId: envelope.jobId,
      resource: "fulfillment",
      channel: "reconciliation",
      itemsProcessed: result.itemsProcessed,
      latestRecordAt: finishedAt,
      startedAt: started,
      finishedAt,
      status: partial ? "partial" : "done",
      ...(partial
        ? { reason: `${String(result.itemsFailed)} item(ns) falharam ao consultar o Mercado Livre (404/403)` }
        : {}),
    }, context.logger);

    context.logger.info("sync_fulfillment_snapshot_done", {
      ml_account_id: mlAccountId,
      items_processed: result.itemsProcessed,
      items_skipped: result.itemsSkipped,
      items_failed: result.itemsFailed,
    });

    return { status: "done", processed: result.itemsProcessed };
  };
}
