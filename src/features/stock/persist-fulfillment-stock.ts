import "server-only";

import { fulfillmentStateHash } from "@/features/stock/stock-domain";
import { createAdminClient } from "@/lib/supabase/admin";

export async function persistFulfillmentStockState(input: {
  organizationId: string;
  mlAccountId: string;
  inventoryId: string;
  totalQuantity: number;
  availableQuantity: number;
  notAvailableQuantity: number;
  notAvailableDetail: unknown[];
  externalReferences: unknown[];
  refreshSource: "backfill" | "notification" | "reconcile" | "manual";
  lastOperationId?: string | null;
  rawPayload: Record<string, unknown>;
}) {
  const admin = createAdminClient();
  const stateHash = fulfillmentStateHash({
    inventoryId: input.inventoryId,
    totalQuantity: input.totalQuantity,
    availableQuantity: input.availableQuantity,
    notAvailableQuantity: input.notAvailableQuantity,
    notAvailableDetail: input.notAvailableDetail,
    externalReferences: input.externalReferences,
  });
  const { data: previous, error: previousError } = await admin
    .from("ml_fulfillment_stock_states")
    .select("state_hash")
    .eq("organization_id", input.organizationId)
    .eq("ml_account_id", input.mlAccountId)
    .eq("inventory_id", input.inventoryId)
    .maybeSingle<{ state_hash: string }>();
  if (previousError) throw new Error(`FULFILLMENT_STATE_LOOKUP_FAILED:${previousError.message}`);
  const checkedAt = new Date().toISOString();
  const base = {
    organization_id: input.organizationId,
    ml_account_id: input.mlAccountId,
    inventory_id: input.inventoryId,
    total_quantity: input.totalQuantity,
    available_quantity: input.availableQuantity,
    not_available_quantity: input.notAvailableQuantity,
    not_available_detail: input.notAvailableDetail,
    external_references: input.externalReferences,
    state_hash: stateHash,
    refresh_source: input.refreshSource,
    last_operation_id: input.lastOperationId ?? null,
  };
  const { error: snapshotError } = await admin.from("ml_fulfillment_stock_snapshots").insert(base);
  if (snapshotError && snapshotError.code !== "23505") {
    throw new Error(`FULFILLMENT_SNAPSHOT_FAILED:${snapshotError.message}`);
  }
  const { error: stateError } = await admin.from("ml_fulfillment_stock_states").upsert({
    ...base,
    checked_at: checkedAt,
    raw_payload: input.rawPayload,
  }, { onConflict: "organization_id,ml_account_id,inventory_id" });
  if (stateError) throw new Error(`FULFILLMENT_STATE_UPSERT_FAILED:${stateError.message}`);

  if (previous?.state_hash !== stateHash) {
    const [listingResult, variationResult] = await Promise.all([
      admin.from("ml_listings").select("product_id").eq("organization_id", input.organizationId)
        .eq("ml_account_id", input.mlAccountId).eq("inventory_id", input.inventoryId).eq("is_current", true).not("product_id", "is", null),
      admin.from("ml_listing_variations").select("product_id").eq("organization_id", input.organizationId)
        .eq("ml_account_id", input.mlAccountId).eq("inventory_id", input.inventoryId).eq("is_current", true).not("product_id", "is", null),
    ]);
    if (listingResult.error || variationResult.error) {
      throw new Error(
        `FULFILLMENT_PRODUCTS_LOOKUP_FAILED:${listingResult.error?.message ?? variationResult.error?.message}`,
      );
    }
    const productIds = new Set<string>();
    for (const row of [...(listingResult.data ?? []), ...(variationResult.data ?? [])]) {
      if (typeof row.product_id === "string") productIds.add(row.product_id);
    }
    if (productIds.size > 0) {
      const productIdList = [...productIds];
      const { data: activeJobs, error: activeJobsError } = await admin
        .from("operational_alert_jobs")
        .select("product_id")
        .eq("organization_id", input.organizationId)
        .in("product_id", productIdList)
        .in("status", ["queued", "running"]);
      if (activeJobsError) {
        throw new Error(`ALERT_JOB_LOOKUP_FAILED:${activeJobsError.message}`);
      }

      const activeProductIds = new Set(
        (activeJobs ?? []).map((job) => job.product_id as string),
      );
      const jobs = productIdList
        .filter((productId) => !activeProductIds.has(productId))
        .map((productId) => ({
          organization_id: input.organizationId,
          product_id: productId,
          reason: "fulfillment_state_changed",
        }));

      if (jobs.length > 0) {
        const { error } = await admin.from("operational_alert_jobs").insert(jobs);
        if (error?.code === "23505") {
          const retryResults = await Promise.all(
            jobs.map((job) => admin.from("operational_alert_jobs").insert(job)),
          );
          const retryError = retryResults.find(
            (result) => result.error && result.error.code !== "23505",
          )?.error;
          if (retryError) {
            throw new Error(`ALERT_JOB_ENQUEUE_FAILED:${retryError.message}`);
          }
        } else if (error) {
          throw new Error(`ALERT_JOB_ENQUEUE_FAILED:${error.message}`);
        }
      }
    }
  }
  return { stateHash, changed: previous?.state_hash !== stateHash };
}
