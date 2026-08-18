import "server-only";

import { randomUUID } from "node:crypto";

import { getValidMercadoLivreAccessToken } from "@/integrations/mercado-livre/access-token";
import {
  getSellerOrder,
  MercadoLivreOrderRequestError,
  type MercadoLivreOrder,
} from "@/integrations/mercado-livre/orders";
import {
  classifyErrorCode,
  MAX_FETCH_ATTEMPTS,
  retrySeconds,
  shouldRequeueAfterRevisionBump,
  shouldRetryFetchWithinInvocation,
} from "./order-refresh-decisions";
import { persistOrdersBatch } from "./persist-orders-batch";
import { createAdminClient } from "@/lib/supabase/admin";

export {
  shouldRequeueAfterRevisionBump,
  shouldRetryFetchWithinInvocation,
} from "./order-refresh-decisions";

type Job = {
  id: string;
  organization_id: string;
  ml_account_id: string;
  order_id: string;
  seller_id: string;
  attempt_count: number;
  max_attempts: number;
  notification_revision: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function processNextOrderRefreshJob() {
  const admin = createAdminClient();
  const leaseId = randomUUID();

  const { data: jobId, error: claimError } = await admin.rpc(
    "claim_next_ml_order_refresh_job",
    { requested_lease_id: leaseId, lease_duration_seconds: 120 },
  );
  if (claimError) {
    throw new Error(`ORDER_REFRESH_CLAIM_FAILED:${claimError.message}`);
  }
  if (!jobId) {
    return { processed: false, reason: "queue_empty" } as const;
  }

  const { data: job, error: jobError } = await admin
    .from("ml_order_refresh_jobs")
    .select(
      "id,organization_id,ml_account_id,order_id,seller_id,attempt_count,max_attempts,notification_revision",
    )
    .eq("id", jobId)
    .eq("lease_id", leaseId)
    .maybeSingle<Job>();
  if (jobError || !job) {
    throw new Error("ORDER_REFRESH_LOAD_FAILED");
  }

  const capturedRevision = job.notification_revision;

  // A single-order refresh is its own self-contained unit — it gets
  // its own tiny sync_runs row (not shared across the burst) because
  // orders.last_seen_sync_run_id/order_items.last_seen_sync_run_id
  // carry a composite FK to sync_runs(organization_id, ml_account_id,
  // id), and a burst can span jobs from different accounts.
  let syncRunId: string | null = null;

  try {
    const { data: syncRun, error: syncRunError } = await admin
      .from("sync_runs")
      .insert({
        organization_id: job.organization_id,
        ml_account_id: job.ml_account_id,
        sync_type: "order_refresh",
        status: "running",
        batch_size: 1,
        metadata: { origin: "notification", order_id: job.order_id },
      })
      .select("id")
      .single();
    if (syncRunError || !syncRun) {
      throw new Error("ORDER_REFRESH_SYNC_RUN_FAILED");
    }
    syncRunId = syncRun.id;
    if (!syncRunId) {
      throw new Error("ORDER_REFRESH_SYNC_RUN_FAILED");
    }

    const token = await getValidMercadoLivreAccessToken(job.ml_account_id);

    let order: MercadoLivreOrder | null = null;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
      try {
        const result = await getSellerOrder({
          orderId: job.order_id,
          accessToken: token.accessToken,
        });
        order = result.order;
        break;
      } catch (error) {
        lastError = error;
        if (!shouldRetryFetchWithinInvocation({ error, fetchAttempt: attempt })) {
          throw error;
        }
        const retryAfterSeconds =
          error instanceof MercadoLivreOrderRequestError
            ? error.retryAfterSeconds
            : null;
        const waitMs = Math.min((retryAfterSeconds ?? attempt) * 1000, 5000);
        await sleep(waitMs);
      }
    }

    if (!order) {
      throw lastError ?? new Error("ORDER_REFRESH_FETCH_FAILED");
    }

    const persistResult = await persistOrdersBatch({
      admin,
      organizationId: job.organization_id,
      mlAccountId: job.ml_account_id,
      sellerId: job.seller_id,
      orders: [order],
      syncRunId,
    });

    if (persistResult.affectedMetricDates.length > 0) {
      const metricDateFrom = persistResult.affectedMetricDates[0];
      const metricDateTo =
        persistResult.affectedMetricDates[
          persistResult.affectedMetricDates.length - 1
        ];
      const { error: metricsError } = await admin.rpc(
        "rebuild_sales_metrics_for_account_range",
        {
          target_ml_account_id: job.ml_account_id,
          target_date_from: metricDateFrom,
          target_date_to: metricDateTo,
        },
      );
      if (metricsError) {
        throw new Error(
          "O pedido foi persistido, mas as métricas analíticas não puderam ser atualizadas.",
        );
      }
    }

    await admin
      .from("sync_runs")
      .update({
        status: "succeeded",
        records_discovered: 1,
        records_processed: persistResult.importedOrders,
        records_upserted: persistResult.importedOrders,
        finished_at: new Date().toISOString(),
      })
      .eq("id", syncRunId);

    const { data: currentRow, error: revisionError } = await admin
      .from("ml_order_refresh_jobs")
      .select("notification_revision")
      .eq("id", job.id)
      .maybeSingle<{ notification_revision: number }>();
    if (revisionError) {
      throw new Error("ORDER_REFRESH_REVISION_CHECK_FAILED");
    }
    const currentRevision = currentRow?.notification_revision ?? capturedRevision;

    if (shouldRequeueAfterRevisionBump({ capturedRevision, currentRevision })) {
      const { error: requeueError } = await admin
        .from("ml_order_refresh_jobs")
        .update({
          status: "queued",
          lease_id: null,
          lease_expires_at: null,
          next_attempt_at: new Date().toISOString(),
          error_code: null,
          error_message: null,
        })
        .eq("id", job.id)
        .eq("lease_id", leaseId);
      if (requeueError) {
        throw new Error(`ORDER_REFRESH_REQUEUE_FAILED:${requeueError.message}`);
      }
      return {
        processed: true,
        status: "requeued",
        orderId: job.order_id,
        changed: persistResult.importedOrders > 0,
      } as const;
    }

    const { error: finishError } = await admin
      .from("ml_order_refresh_jobs")
      .update({
        status: "succeeded",
        lease_id: null,
        lease_expires_at: null,
        processed_revision: capturedRevision,
        processed_at: new Date().toISOString(),
        error_code: null,
        error_message: null,
      })
      .eq("id", job.id)
      .eq("lease_id", leaseId);
    if (finishError) {
      throw new Error(`ORDER_REFRESH_FINISH_FAILED:${finishError.message}`);
    }

    return {
      processed: true,
      status: "succeeded",
      orderId: job.order_id,
      changed: persistResult.importedOrders > 0,
    } as const;
  } catch (error) {
    if (syncRunId) {
      const { error: syncRunFailureError } = await admin
        .from("sync_runs")
        .update({
          status: "failed",
          error_code: "order_refresh_failed",
          error_message:
            error instanceof Error ? error.message.slice(0, 500) : "unknown_error",
          finished_at: new Date().toISOString(),
        })
        .eq("id", syncRunId);
      if (syncRunFailureError) {
        console.error(
          "ORDER_REFRESH_SYNC_RUN_FAILURE_CHECKPOINT_FAILED:",
          syncRunFailureError.message,
        );
      }
    }

    const classified =
      error instanceof MercadoLivreOrderRequestError ? error : null;
    const retryable = classified ? classified.retryable : true;
    const failed = !retryable || job.attempt_count >= job.max_attempts;

    const { error: retryCheckpointError } = await admin
      .from("ml_order_refresh_jobs")
      .update({
        status: failed ? "failed" : "queued",
        lease_id: null,
        lease_expires_at: null,
        next_attempt_at: new Date(
          Date.now() + retrySeconds(job.attempt_count) * 1000,
        ).toISOString(),
        error_code: classifyErrorCode(error),
        error_message: (error instanceof Error
          ? error.message
          : "unknown_error"
        ).slice(0, 500),
        processed_at: failed ? new Date().toISOString() : null,
      })
      .eq("id", job.id)
      .eq("lease_id", leaseId);
    if (retryCheckpointError) {
      throw new Error(
        `ORDER_REFRESH_RETRY_FAILED:${retryCheckpointError.message}`,
      );
    }
    throw error;
  }
}
