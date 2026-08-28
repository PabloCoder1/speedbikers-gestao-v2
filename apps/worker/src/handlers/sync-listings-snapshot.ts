import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { fetchListings } from "./ml-listings-fetch.js";
import { ensureAccessToken } from "./ml-token.js";
import { recordSyncRunFailure, recordSyncRunSuccess } from "./sync-runs.js";

/**
 * `sync.listings.snapshot` — sincronização de listings/anúncios (D-058,
 * `docs/ROADMAP.md` Fase 5B). Mesmo formato de `sync.fulfillment.snapshot`:
 * uma varredura completa por execução (projeção de estado atual, não
 * incremental) — `resource: "listings"` já estava previsto no CHECK de
 * `sync_runs` desde a migration de observabilidade da Fase 2.
 */

const payloadSchema = z.object({ mlAccountId: z.uuid() });

export interface SyncListingsSnapshotDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
}

export function createSyncListingsSnapshotHandler(deps: SyncListingsSnapshotDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem mlAccountId" };
    }

    const { mlAccountId } = parsed.data;
    const now = deps.now?.() ?? new Date();

    const account = await deps.db
      .from("ml_accounts")
      .select("id, organization_id, status, seller_id")
      .eq("id", mlAccountId)
      .maybeSingle();

    if (account.error !== null || account.data === null) {
      context.logger.warn("sync_listings_snapshot_account_missing", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    if (account.data.status !== "CONNECTED") {
      context.logger.info("sync_listings_snapshot_account_not_connected", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    const { organization_id: organizationId, seller_id: sellerId } = account.data;

    // Sem  não há como enumerar o catálogo (a busca é por VENDEDOR,
    // não por conta interna). Conta CONNECTED sem ele é incoerência de dado,
    // não falha transitória — por isso não é retryable.
    if (sellerId === null) {
      context.logger.warn("sync_listings_snapshot_seller_id_missing", { ml_account_id: mlAccountId });

      return { status: "failed", retryable: false, reason: "conta CONNECTED sem seller_id" };
    }
    const started = now;
    const tokenResult = await ensureAccessToken(deps, mlAccountId, now);

    if (!tokenResult.ok) {
      await recordSyncRunFailure(deps.db, {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        resource: "listings",
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
      result = await fetchListings({
        db: deps.db,
        organizationId,
        mlAccountId,
        sellerId,
        mercadoLivre: deps.mercadoLivre,
        accessToken: tokenResult.accessToken,
        logger: context.logger,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      });
    } catch (error) {
      const finishedAt = deps.now?.() ?? new Date();
      const errorClass = error instanceof MercadoLivreApiError ? error.errorClass : "retryable";
      const reason = error instanceof Error ? error.message : "erro desconhecido ao sincronizar listings";

      await recordSyncRunFailure(deps.db, {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        resource: "listings",
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

    await recordSyncRunSuccess(deps.db, {
      organizationId,
      mlAccountId,
      jobId: envelope.jobId,
      resource: "listings",
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

    context.logger.info("sync_listings_snapshot_done", {
      ml_account_id: mlAccountId,
      items_discovered: result.itemsDiscovered,
      items_processed: result.itemsProcessed,
      items_failed: result.itemsFailed,
      items_without_link: result.itemsWithoutLink,
    });

    return { status: "done", processed: result.itemsProcessed };
  };
}
