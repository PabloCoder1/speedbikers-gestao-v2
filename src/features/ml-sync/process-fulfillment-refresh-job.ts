import "server-only";

import { randomUUID } from "node:crypto";

import { persistFulfillmentStockState } from "@/features/stock/persist-fulfillment-stock";
import { getValidMercadoLivreAccessToken } from "@/integrations/mercado-livre/access-token";
import {
  getMercadoLivreFulfillmentOperation,
  getMercadoLivreFulfillmentStock,
  MercadoLivreFulfillmentRequestError,
} from "@/integrations/mercado-livre/fulfillment";
import { createAdminClient } from "@/lib/supabase/admin";

type Job = {
  id: string;
  organization_id: string;
  ml_account_id: string;
  operation_id: string;
  seller_id: string;
  attempt_count: number;
  max_attempts: number;
};

function retrySeconds(attempt: number) {
  return Math.min(30 * 2 ** Math.max(0, attempt - 1) + Math.floor(Math.random() * 16), 15 * 60);
}

export async function processNextFulfillmentRefreshJob() {
  const admin = createAdminClient();
  const leaseId = randomUUID();
  const { data: jobId, error: claimError } = await admin.rpc("claim_next_ml_fulfillment_refresh_job", {
    requested_lease_id: leaseId,
    lease_duration_seconds: 120,
  });
  if (claimError) throw new Error(`FULFILLMENT_REFRESH_CLAIM_FAILED:${claimError.message}`);
  if (!jobId) return { processed: false, reason: "queue_empty" } as const;
  const { data: job, error: jobError } = await admin.from("ml_fulfillment_stock_refresh_jobs")
    .select("id,organization_id,ml_account_id,operation_id,seller_id,attempt_count,max_attempts")
    .eq("id", jobId).eq("lease_id", leaseId).maybeSingle<Job>();
  if (jobError || !job) throw new Error("FULFILLMENT_REFRESH_LOAD_FAILED");

  const finish = async (status: "succeeded" | "ignored", values: Record<string, unknown> = {}) => {
    const { error } = await admin.from("ml_fulfillment_stock_refresh_jobs").update({
      status, lease_id: null, lease_expires_at: null, processed_at: new Date().toISOString(), ...values,
    }).eq("id", job.id).eq("lease_id", leaseId);
    if (error) throw new Error(`FULFILLMENT_REFRESH_FINISH_FAILED:${error.message}`);
  };

  try {
    const token = await getValidMercadoLivreAccessToken(job.ml_account_id);
    let operation;
    try {
      operation = await getMercadoLivreFulfillmentOperation({ operationId: job.operation_id, accessToken: token.accessToken });
    } catch (error) {
      if (error instanceof MercadoLivreFulfillmentRequestError && error.staleOrNotApplicable) {
        await finish("ignored", { error_code: "operation_not_found", error_message: error.responseMessage });
        return { processed: true, status: "ignored", reason: "operation_not_found" } as const;
      }
      throw error;
    }
    if (operation.normalized.sellerId && operation.normalized.sellerId !== job.seller_id) {
      await finish("ignored", { error_code: "seller_mismatch", error_message: "A operação pertence a outro seller." });
      return { processed: true, status: "ignored", reason: "seller_mismatch" } as const;
    }
    const inventoryId = operation.normalized.inventoryId;
    if (!inventoryId) {
      await finish("ignored", { error_code: "inventory_id_missing", error_message: "Operação sem inventory_id." });
      return { processed: true, status: "ignored", reason: "inventory_id_missing" } as const;
    }
    let stock;
    try {
      stock = await getMercadoLivreFulfillmentStock({ inventoryId, accessToken: token.accessToken });
    } catch (error) {
      if (error instanceof MercadoLivreFulfillmentRequestError && error.staleOrNotApplicable) {
        await finish("ignored", { inventory_id: inventoryId, error_code: "inventory_stale", error_message: error.responseMessage });
        return { processed: true, status: "ignored", reason: "inventory_stale" } as const;
      }
      throw error;
    }
    await persistFulfillmentStockState({
      organizationId: job.organization_id,
      mlAccountId: job.ml_account_id,
      inventoryId: stock.normalized.inventoryId,
      totalQuantity: stock.normalized.total,
      availableQuantity: stock.normalized.availableQuantity,
      notAvailableQuantity: stock.normalized.notAvailableQuantity,
      notAvailableDetail: stock.normalized.notAvailableDetail,
      externalReferences: stock.normalized.externalReferences,
      refreshSource: "notification",
      lastOperationId: job.operation_id,
      rawPayload: stock.raw,
    });
    await finish("succeeded", { inventory_id: stock.normalized.inventoryId, error_code: null, error_message: null });
    return { processed: true, status: "succeeded", jobId: job.id, inventoryId: stock.normalized.inventoryId } as const;
  } catch (error) {
    const retryable = !(error instanceof MercadoLivreFulfillmentRequestError) || error.retryable;
    const failed = !retryable || job.attempt_count >= job.max_attempts;
    await admin.from("ml_fulfillment_stock_refresh_jobs").update({
      status: failed ? "failed" : "queued",
      lease_id: null, lease_expires_at: null,
      next_attempt_at: new Date(Date.now() + retrySeconds(job.attempt_count) * 1000).toISOString(),
      error_code: "fulfillment_refresh_failed",
      error_message: (error instanceof Error ? error.message : "unknown_error").slice(0, 500),
      processed_at: failed ? new Date().toISOString() : null,
    }).eq("id", job.id).eq("lease_id", leaseId);
    throw error;
  }
}
