import "server-only";

import { randomUUID } from "node:crypto";

import { persistListingPromotionState } from "@/features/ml-sync/persist-listing-promotion-state";
import { resolveListingPriceState } from "@/features/ml-sync/resolve-listing-price-state";
import { getValidMercadoLivreAccessToken } from "@/integrations/mercado-livre/access-token";
import { createAdminClient } from "@/lib/supabase/admin";

const LEASE_SECONDS = 120;
const FAIR_QUEUE_DELAY_MS = 5_000;

type SyncRunRow = {
  id: string; organization_id: string; ml_account_id: string;
  cursor_offset: number; batch_size: number; records_discovered: number;
  records_processed: number; records_upserted: number;
  retry_count: number; max_retries: number; metadata: unknown;
};
type ListingRow = {
  id: string; product_id: string | null; item_id: string;
  seller_sku: string | null; currency_id: string | null;
  price: number | string | null;
};
type ItemFailure = { listingId: string; itemId: string; message: string };

function asMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function metadataInteger(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function metadataFailures(metadata: Record<string, unknown>): ItemFailure[] {
  const value = metadata.failed_items;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      listingId: typeof item.listingId === "string" ? item.listingId : "",
      itemId: typeof item.itemId === "string" ? item.itemId : "",
      message: typeof item.message === "string" ? item.message : "Erro desconhecido",
    })).filter((item) => Boolean(item.listingId && item.itemId));
}
function appendFailures(current: ItemFailure[], additions: ItemFailure[]) {
  const byListing = new Map<string, ItemFailure>();
  for (const failure of current) byListing.set(failure.listingId, failure);
  for (const failure of additions) byListing.set(failure.listingId, failure);
  return Array.from(byListing.values()).slice(-100);
}
function legacyPrice(value: number | string | null) {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 500) : "Erro desconhecido";
}
function retryDelaySeconds(retryCount: number) {
  return Math.min(30 * Math.pow(2, Math.max(0, retryCount - 1)), 15 * 60);
}

export async function processNextOfferPricesBackfillBatch() {
  const admin = createAdminClient();
  const leaseId = randomUUID();
  const { data: syncRunId, error: claimError } = await admin.rpc(
    "claim_next_offer_prices_backfill_run",
    { requested_lease_id: leaseId, lease_duration_seconds: LEASE_SECONDS },
  );
  if (claimError) throw new Error("Não foi possível adquirir um backfill de preços/promos.");
  if (!syncRunId) return { processed: false, reason: "queue_empty" } as const;

  const { data, error: runError } = await admin.from("sync_runs")
    .select("id,organization_id,ml_account_id,cursor_offset,batch_size,records_discovered,records_processed,records_upserted,retry_count,max_retries,metadata")
    .eq("id", syncRunId).eq("lease_id", leaseId).maybeSingle<SyncRunRow>();
  if (runError || !data) throw new Error("O backfill foi adquirido, mas não pôde ser carregado.");
  const run = data;
  const metadata = asMetadata(run.metadata);
  const cursorListingId = typeof metadata.cursor_listing_id === "string" && metadata.cursor_listing_id.length > 0
    ? metadata.cursor_listing_id : null;

  try {
    const token = await getValidMercadoLivreAccessToken(run.ml_account_id);
    let query = admin.from("ml_listings")
      .select("id,product_id,item_id,seller_sku,currency_id,price")
      .eq("organization_id", run.organization_id).eq("ml_account_id", run.ml_account_id)
      .eq("is_current", true).order("id", { ascending: true }).limit(run.batch_size);
    if (cursorListingId) query = query.gt("id", cursorListingId);
    const { data: listingData, error: listingError } = await query.returns<ListingRow[]>();
    if (listingError) throw new Error("Não foi possível carregar o próximo lote de anúncios.");
    const listings = listingData ?? [];

    if (listings.length === 0) {
      const failureCount = metadataInteger(metadata, "failure_count");
      const finalStatus = failureCount > 0 ? "partial" : "succeeded";
      const now = new Date().toISOString();
      const { error: finishError } = await admin.from("sync_runs").update({
        status: finalStatus, lease_id: null, lease_expires_at: null, retry_count: 0,
        finished_at: now, error_code: failureCount > 0 ? "offer_prices_partial" : null,
        error_message: failureCount > 0 ? `${failureCount} anúncio(s) não puderam ser resolvidos após as tentativas.` : null,
        metadata: { ...metadata, completed_at: now },
      }).eq("id", run.id).eq("lease_id", leaseId);
      if (finishError) throw new Error("O backfill terminou, mas não foi possível finalizá-lo.");
      return { processed: true, completed: true, status: finalStatus, syncRunId: run.id,
        processedItems: run.records_processed, upsertedItems: run.records_upserted, failures: failureCount } as const;
    }

    const settled = await Promise.allSettled(listings.map(async (listing) => {
      const state = await resolveListingPriceState({
        itemId: listing.item_id, legacyListingPrice: legacyPrice(listing.price), accessToken: token.accessToken,
      });
      return persistListingPromotionState({
        listing: { id: listing.id, organizationId: run.organization_id, mlAccountId: run.ml_account_id,
          productId: listing.product_id, itemId: listing.item_id,
          sellerSku: listing.seller_sku, currencyId: listing.currency_id },
        state, sourceSyncRunId: run.id,
      });
    }));
    let successCount = 0;
    let snapshotsInserted = 0;
    const failures: ItemFailure[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        successCount += 1;
        if (result.value.snapshotInserted) snapshotsInserted += 1;
      } else {
        failures.push({ listingId: listings[index].id, itemId: listings[index].item_id, message: errorMessage(result.reason) });
      }
    });
    const currentSnapshots = metadataInteger(metadata, "snapshots_inserted_total");

    if (failures.length > 0) {
      const nextRetry = run.retry_count + 1;
      if (nextRetry <= run.max_retries) {
        const nextAttemptAt = new Date(Date.now() + retryDelaySeconds(nextRetry) * 1000).toISOString();
        const { error: retryUpdateError } = await admin.from("sync_runs").update({
          status: "queued", retry_count: nextRetry, next_attempt_at: nextAttemptAt,
          lease_id: null, lease_expires_at: null, error_code: "offer_prices_batch_retry",
          error_message: failures.map((failure) => `${failure.itemId}: ${failure.message}`).join(" | ").slice(0, 1500),
          metadata: { ...metadata, snapshots_inserted_total: currentSnapshots + snapshotsInserted,
            last_batch_items: listings.length, last_batch_successes: successCount,
            last_batch_failures: failures, last_batch_retry: nextRetry, last_batch_finished_at: new Date().toISOString() },
        }).eq("id", run.id).eq("lease_id", leaseId);
        if (retryUpdateError) throw new Error("O lote falhou e o retry não pôde ser salvo.");
        return { processed: true, completed: false, retrying: true, syncRunId: run.id,
          retry: nextRetry, failures: failures.length } as const;
      }
    }

    const existingFailureCount = metadataInteger(metadata, "failure_count");
    const newFailureCount = existingFailureCount + failures.length;
    const newOffset = run.cursor_offset + listings.length;
    const newProcessed = run.records_processed + listings.length;
    const newUpserted = run.records_upserted + successCount;
    const lastListing = listings[listings.length - 1];
    const complete = listings.length < run.batch_size;
    const updatedMetadata = {
      ...metadata, cursor_listing_id: lastListing.id, failure_count: newFailureCount,
      failed_items: appendFailures(metadataFailures(metadata), failures),
      snapshots_inserted_total: currentSnapshots + snapshotsInserted,
      last_batch_items: listings.length, last_batch_successes: successCount,
      last_batch_failures: failures, last_batch_finished_at: new Date().toISOString(),
    };

    if (complete) {
      const finalStatus = newFailureCount > 0 ? "partial" : "succeeded";
      const { error: finalizeError } = await admin.from("sync_runs").update({
        cursor_offset: newOffset, records_processed: newProcessed, records_upserted: newUpserted,
        status: finalStatus, retry_count: 0, lease_id: null, lease_expires_at: null,
        error_code: newFailureCount > 0 ? "offer_prices_partial" : null,
        error_message: newFailureCount > 0 ? `${newFailureCount} anúncio(s) não puderam ser resolvidos após as tentativas.` : null,
        metadata: updatedMetadata, finished_at: new Date().toISOString(),
      }).eq("id", run.id).eq("lease_id", leaseId);
      if (finalizeError) throw new Error("Não foi possível finalizar o backfill de preços.");
      return { processed: true, completed: true, status: finalStatus, syncRunId: run.id,
        processedItems: newProcessed, upsertedItems: newUpserted, failures: newFailureCount } as const;
    }

    const { error: progressError } = await admin.from("sync_runs").update({
      cursor_offset: newOffset, records_processed: newProcessed, records_upserted: newUpserted,
      retry_count: 0, error_code: null, error_message: null, metadata: updatedMetadata,
      status: "queued", lease_id: null, lease_expires_at: null,
      next_attempt_at: new Date(Date.now() + FAIR_QUEUE_DELAY_MS).toISOString(),
    }).eq("id", run.id).eq("lease_id", leaseId);
    if (progressError) throw new Error("O lote terminou, mas o checkpoint não pôde ser salvo.");
    return { processed: true, completed: false, syncRunId: run.id,
      processedItems: newProcessed, upsertedItems: newUpserted,
      batchItems: listings.length, failures: newFailureCount } as const;
  } catch (error) {
    const nextRetry = run.retry_count + 1;
    const failed = nextRetry > run.max_retries;
    const nextAttemptAt = new Date(Date.now() + retryDelaySeconds(nextRetry) * 1000).toISOString();
    await admin.from("sync_runs").update({
      status: failed ? "failed" : "queued", retry_count: nextRetry, next_attempt_at: nextAttemptAt,
      lease_id: null, lease_expires_at: null, error_code: "offer_prices_backfill_failed",
      error_message: errorMessage(error), finished_at: failed ? new Date().toISOString() : null,
    }).eq("id", run.id).eq("lease_id", leaseId);
    throw error;
  }
}
