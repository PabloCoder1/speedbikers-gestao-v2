import "server-only";

import { randomUUID } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";

const DEFAULT_BURST_RUNTIME_MS = 40_000;
const DEFAULT_BURST_JOBS = 250;

type ReconcileJob = {
  id: string;
  product_id: string;
  attempt_count: number;
  max_attempts: number;
};

function compactError(error: unknown) {
  return (error instanceof Error ? error.message : "unknown_error").slice(0, 500);
}

export async function processNextProductInventoryReconcileJob() {
  const admin = createAdminClient();
  const leaseId = randomUUID();
  const { data: jobId, error: claimError } = await admin.rpc(
    "claim_next_product_inventory_reconcile_job",
    { requested_lease_id: leaseId, lease_duration_seconds: 120 },
  );

  if (claimError) throw new Error(`INVENTORY_RECONCILE_CLAIM_FAILED:${claimError.message}`);
  if (!jobId) return { processed: false, reason: "queue_empty" } as const;

  const { data: job, error: jobError } = await admin
    .from("product_inventory_reconcile_jobs")
    .select("id,product_id,attempt_count,max_attempts")
    .eq("id", jobId)
    .eq("lease_id", leaseId)
    .maybeSingle<ReconcileJob>();

  if (jobError || !job) throw new Error("INVENTORY_RECONCILE_JOB_LOAD_FAILED");

  try {
    const { data: result, error: reconcileError } = await admin.rpc(
      "reconcile_product_inventory_link",
      { target_product_id: job.product_id },
    );
    if (reconcileError) {
      throw new Error(`INVENTORY_RECONCILE_FAILED:${reconcileError.message}`);
    }

    const { error: finishError } = await admin
      .from("product_inventory_reconcile_jobs")
      .update({
        status: "completed",
        lease_id: null,
        lease_expires_at: null,
        error_code: null,
        error_message: null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("lease_id", leaseId);
    if (finishError) throw new Error(`INVENTORY_RECONCILE_FINISH_FAILED:${finishError.message}`);

    return { processed: true, jobId: job.id, result } as const;
  } catch (error) {
    const failed = job.attempt_count >= job.max_attempts;
    const delaySeconds = Math.min(
      30 * 2 ** Math.max(0, job.attempt_count - 1) + Math.floor(Math.random() * 16),
      900,
    );

    await admin
      .from("product_inventory_reconcile_jobs")
      .update({
        status: failed ? "failed" : "queued",
        lease_id: null,
        lease_expires_at: null,
        next_attempt_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
        error_code: "inventory_reconcile_failed",
        error_message: compactError(error),
        completed_at: failed ? new Date().toISOString() : null,
      })
      .eq("id", job.id)
      .eq("lease_id", leaseId);

    throw error;
  }
}

export async function processProductInventoryReconcileBurst({
  maxRuntimeMs = DEFAULT_BURST_RUNTIME_MS,
  maxJobs = DEFAULT_BURST_JOBS,
}: {
  maxRuntimeMs?: number;
  maxJobs?: number;
} = {}) {
  const startedAt = Date.now();
  let jobsProcessed = 0;
  let lastResult: Awaited<ReturnType<typeof processNextProductInventoryReconcileJob>> | null = null;

  while (jobsProcessed < maxJobs && Date.now() - startedAt < maxRuntimeMs) {
    const result = await processNextProductInventoryReconcileJob();
    lastResult = result;
    if (!result.processed) break;
    jobsProcessed += 1;
  }

  return {
    processed: jobsProcessed > 0,
    jobsProcessed,
    durationMs: Date.now() - startedAt,
    deadlineReached: Date.now() - startedAt >= maxRuntimeMs,
    lastResult,
  } as const;
}
