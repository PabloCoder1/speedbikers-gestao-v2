import "server-only";

import { randomUUID } from "node:crypto";

import { persistFulfillmentStockState } from "@/features/stock/persist-fulfillment-stock";
import { getValidMercadoLivreAccessToken } from "@/integrations/mercado-livre/access-token";
import {
  getMercadoLivreFulfillmentStock,
  MercadoLivreFulfillmentRequestError,
} from "@/integrations/mercado-livre/fulfillment";
import { createAdminClient } from "@/lib/supabase/admin";

const LEASE_SECONDS = 120;
const MAX_BURST_BATCHES = 4;
const TIME_BUDGET_MS = 48_000;

type RunRow = {
  id: string;
  organization_id: string;
  ml_account_id: string;
  batch_size: number;
  records_processed: number;
  records_upserted: number;
  retry_count: number;
  max_retries: number;
  metadata: unknown;
};

function metadata(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function retrySeconds(attempt: number) {
  return Math.min(30 * 2 ** Math.max(0, attempt - 1) + Math.floor(Math.random() * 16), 15 * 60);
}

export async function processFulfillmentStockBackfillBurst() {
  const admin = createAdminClient();
  const leaseId = randomUUID();
  const { data: runId, error: claimError } = await admin.rpc("claim_next_fulfillment_stock_sync_run", {
    requested_lease_id: leaseId,
    lease_duration_seconds: LEASE_SECONDS,
  });
  if (claimError) throw new Error(`FULFILLMENT_RUN_CLAIM_FAILED:${claimError.message}`);
  if (!runId) return { processed: false, reason: "queue_empty" } as const;
  const { data: run, error: runError } = await admin.from("sync_runs")
    .select("id,organization_id,ml_account_id,batch_size,records_processed,records_upserted,retry_count,max_retries,metadata")
    .eq("id", runId).eq("lease_id", leaseId).maybeSingle<RunRow>();
  if (runError || !run) throw new Error("FULFILLMENT_RUN_LOAD_FAILED");

  const startedAt = Date.now();
  const state = metadata(run.metadata);
  let cursor = typeof state.cursor_inventory_id === "string" ? state.cursor_inventory_id : null;
  let processed = run.records_processed;
  let upserted = run.records_upserted;
  let batches = 0;

  try {
    const token = await getValidMercadoLivreAccessToken(run.ml_account_id);
    while (batches < MAX_BURST_BATCHES && Date.now() - startedAt < TIME_BUDGET_MS) {
      const { data: targets, error: targetError } = await admin.rpc("get_fulfillment_inventory_targets", {
        target_sync_run_id: run.id,
        cursor_inventory_id: cursor,
        requested_limit: run.batch_size,
      });
      if (targetError) throw new Error(`FULFILLMENT_TARGETS_FAILED:${targetError.message}`);
      const inventoryIds = ((targets ?? []) as { inventory_id: string }[]).map((target) => target.inventory_id);
      if (inventoryIds.length === 0) {
        const { error: completionError } = await admin.from("sync_runs").update({
          status: "succeeded", records_processed: processed, records_upserted: upserted,
          retry_count: 0, lease_reclaim_count: 0, lease_id: null, lease_expires_at: null, finished_at: new Date().toISOString(),
          metadata: { ...state, cursor_inventory_id: cursor, completed_at: new Date().toISOString() },
        }).eq("id", run.id).eq("lease_id", leaseId);
        if (completionError) throw new Error(`FULFILLMENT_COMPLETE_FAILED:${completionError.message}`);
        return { processed: true, completed: true, runId: run.id, recordsProcessed: processed, recordsUpserted: upserted } as const;
      }

      const results = await Promise.all(inventoryIds.map(async (inventoryId) => {
        try {
          const response = await getMercadoLivreFulfillmentStock({ inventoryId, accessToken: token.accessToken });
          await persistFulfillmentStockState({
            organizationId: run.organization_id,
            mlAccountId: run.ml_account_id,
            inventoryId: response.normalized.inventoryId,
            totalQuantity: response.normalized.total,
            availableQuantity: response.normalized.availableQuantity,
            notAvailableQuantity: response.normalized.notAvailableQuantity,
            notAvailableDetail: response.normalized.notAvailableDetail,
            externalReferences: response.normalized.externalReferences,
            refreshSource: state.mode === "reconcile" ? "reconcile" : "backfill",
            rawPayload: response.raw,
          });
          return "upserted" as const;
        } catch (error) {
          if (error instanceof MercadoLivreFulfillmentRequestError && error.staleOrNotApplicable) return "ignored" as const;
          throw error;
        }
      }));
      processed += inventoryIds.length;
      upserted += results.filter((result) => result === "upserted").length;
      cursor = inventoryIds.at(-1) ?? cursor;
      batches += 1;
      const complete = inventoryIds.length < run.batch_size;
      const { error: checkpointError } = await admin.from("sync_runs").update({
        records_processed: processed,
        records_upserted: upserted,
        retry_count: 0, lease_reclaim_count: 0,
        metadata: { ...state, cursor_inventory_id: cursor, last_batch_at: new Date().toISOString() },
      }).eq("id", run.id).eq("lease_id", leaseId);
      if (checkpointError) throw new Error(`FULFILLMENT_CHECKPOINT_FAILED:${checkpointError.message}`);
      if (complete) {
        const { error: completionError } = await admin.from("sync_runs").update({
          status: "succeeded", lease_id: null, lease_expires_at: null,
          finished_at: new Date().toISOString(),
          metadata: { ...state, cursor_inventory_id: cursor, completed_at: new Date().toISOString() },
        }).eq("id", run.id).eq("lease_id", leaseId);
        if (completionError) throw new Error(`FULFILLMENT_COMPLETE_FAILED:${completionError.message}`);
        return { processed: true, completed: true, runId: run.id, recordsProcessed: processed, recordsUpserted: upserted } as const;
      }
    }

    const { error: releaseError } = await admin.from("sync_runs").update({
      status: "queued", lease_id: null, lease_expires_at: null,
      next_attempt_at: new Date().toISOString(), retry_count: 0, lease_reclaim_count: 0,
      metadata: { ...state, cursor_inventory_id: cursor, last_burst_at: new Date().toISOString() },
    }).eq("id", run.id).eq("lease_id", leaseId);
    if (releaseError) throw new Error(`FULFILLMENT_RELEASE_FAILED:${releaseError.message}`);
    return { processed: true, completed: false, runId: run.id, batches, recordsProcessed: processed } as const;
  } catch (error) {
    const attempt = run.retry_count + 1;
    const retryable = !(error instanceof MercadoLivreFulfillmentRequestError) || error.retryable;
    const failed = !retryable || attempt > run.max_retries;
    const { error: retryCheckpointError } = await admin.from("sync_runs").update({
      status: failed ? "failed" : "queued",
      retry_count: attempt,
      next_attempt_at: new Date(Date.now() + retrySeconds(attempt) * 1000).toISOString(),
      lease_id: null, lease_expires_at: null,
      error_code: "fulfillment_stock_backfill_failed",
      error_message: (error instanceof Error ? error.message : "unknown_error").slice(0, 500),
      finished_at: failed ? new Date().toISOString() : null,
      metadata: { ...state, cursor_inventory_id: cursor },
    }).eq("id", run.id).eq("lease_id", leaseId);
    if (retryCheckpointError) {
      throw new Error(`FULFILLMENT_RETRY_FAILED:${retryCheckpointError.message}`);
    }
    throw error;
  }
}
