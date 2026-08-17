import "server-only";

import { randomUUID } from "node:crypto";

import { evaluateProductOperationalAlerts } from "@/features/stock/evaluate-product-operational-alerts";
import { createAdminClient } from "@/lib/supabase/admin";

type AlertJob = {
  id: string;
  product_id: string;
  attempt_count: number;
  max_attempts: number;
};

export async function processNextOperationalAlertJob() {
  const admin = createAdminClient();
  const leaseId = randomUUID();
  const { data: jobId, error: claimError } = await admin.rpc("claim_next_operational_alert_job", {
    requested_lease_id: leaseId,
    lease_duration_seconds: 120,
  });
  if (claimError) throw new Error(`ALERT_JOB_CLAIM_FAILED:${claimError.message}`);
  if (!jobId) return { processed: false, reason: "queue_empty" } as const;
  const { data: job, error: jobError } = await admin.from("operational_alert_jobs")
    .select("id,product_id,attempt_count,max_attempts").eq("id", jobId).eq("lease_id", leaseId).maybeSingle<AlertJob>();
  if (jobError || !job) throw new Error("ALERT_JOB_LOAD_FAILED");
  try {
    const result = await evaluateProductOperationalAlerts(job.product_id);
    const { error } = await admin.from("operational_alert_jobs").update({
      status: "succeeded", lease_id: null, lease_expires_at: null,
      error_code: null, error_message: null, processed_at: new Date().toISOString(),
    }).eq("id", job.id).eq("lease_id", leaseId);
    if (error) throw new Error(`ALERT_JOB_FINISH_FAILED:${error.message}`);
    return { processed: true, jobId: job.id, result } as const;
  } catch (error) {
    const failed = job.attempt_count >= job.max_attempts;
    const delay = Math.min(30 * 2 ** Math.max(0, job.attempt_count - 1) + Math.floor(Math.random() * 16), 900);
    const { error: retryCheckpointError } = await admin.from("operational_alert_jobs").update({
      status: failed ? "failed" : "queued", lease_id: null, lease_expires_at: null,
      next_attempt_at: new Date(Date.now() + delay * 1000).toISOString(),
      error_code: "operational_alert_evaluation_failed",
      error_message: (error instanceof Error ? error.message : "unknown_error").slice(0, 500),
      processed_at: failed ? new Date().toISOString() : null,
    }).eq("id", job.id).eq("lease_id", leaseId);
    if (retryCheckpointError) {
      throw new Error(`ALERT_JOB_RETRY_FAILED:${retryCheckpointError.message}`);
    }
    throw error;
  }
}
