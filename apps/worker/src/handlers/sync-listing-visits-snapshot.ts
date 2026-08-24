import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { fetchListingVisits } from "./ml-listing-visits-fetch.js";
import { ensureAccessToken } from "./ml-token.js";
import { recordSyncRunFailure, recordSyncRunSuccess } from "./sync-runs.js";

/**
 * `sync.listing-visits.snapshot` — sincronização de visitas por anúncio
 * (D-032, `docs/ROADMAP.md` Fase 5B). Mesmo formato de
 * `sync.listings.snapshot`. `resource: "visits"` — primeiro uso do valor,
 * precisou alargar o CHECK de `sync_runs`/`sync_errors`
 * (`20260823184120_create_daily_listing_visits.sql`).
 */

const payloadSchema = z.object({ mlAccountId: z.uuid() });

export interface SyncListingVisitsSnapshotDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
}

export function createSyncListingVisitsSnapshotHandler(
  deps: SyncListingVisitsSnapshotDeps,
): JobHandler {
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
      context.logger.warn("sync_listing_visits_snapshot_account_missing", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    if (account.data.status !== "CONNECTED") {
      context.logger.info("sync_listing_visits_snapshot_account_not_connected", {
        ml_account_id: mlAccountId,
      });

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
        resource: "visits",
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
      result = await fetchListingVisits({
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
      const reason = error instanceof Error ? error.message : "erro desconhecido ao sincronizar visitas";

      await recordSyncRunFailure(deps.db, {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        resource: "visits",
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
      resource: "visits",
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

    context.logger.info("sync_listing_visits_snapshot_done", {
      ml_account_id: mlAccountId,
      items_processed: result.itemsProcessed,
      items_failed: result.itemsFailed,
    });

    return { status: "done", processed: result.itemsProcessed };
  };
}
