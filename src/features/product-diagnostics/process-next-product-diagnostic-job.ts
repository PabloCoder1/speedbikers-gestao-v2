import "server-only";

import { randomUUID } from "node:crypto";

import { getAnthropicClient, getProductDiagnosticModel } from "@/integrations/anthropic/client";
import { buildProductDiagnosticEvidenceV2ForProduct } from "@/features/product-diagnostics/build-product-diagnostic-evidence-v2";
import { PRODUCT_DIAGNOSTIC_EVIDENCE_VERSION_V2 } from "@/features/product-diagnostics/product-diagnostic-domain";
import { PRODUCT_DIAGNOSTIC_PROMPT_VERSION_V2 } from "@/features/product-diagnostics/product-diagnostic-prompt-v2";
import { resolveDiagnosticCacheDecision } from "@/features/product-diagnostics/product-diagnostic-domain";
import { runProductDiagnosticV2 } from "@/features/product-diagnostics/run-product-diagnostic-v2";
import { retryDelaySeconds, resolveJobOutcomeAction } from "@/features/product-diagnostics/product-diagnostic-job-retry";
import { createAdminClient } from "@/lib/supabase/admin";

const LEASE_DURATION_SECONDS = 120;
// product_diagnostic_runs has no lease/timeout column of its own (it's a
// result cache + advisory lock, not a job queue) — if the worker function
// that inserted a 'running' row gets killed by the platform timeout before
// updating it to succeeded/failed, that row blocks every future attempt
// for the same product forever via product_diagnostic_runs_running_lock_idx.
// Real production evidence: two rows stuck 'running' with completed_at=null
// after the worker's maxDuration was exceeded, both blocking retries with
// PRODUCT_DIAGNOSTIC_RUN_LOCK_FAILED. Comfortably above maxDuration=180s.
const STALE_RUNNING_DIAGNOSTIC_RUN_MS = 5 * 60 * 1000;

type JobRow = {
  id: string;
  organization_id: string;
  product_id: string;
  requested_by: string;
  force: boolean;
  attempt_count: number;
  max_attempts: number;
};

async function resolveAllActiveMlAccountIds(organizationId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("ml_accounts").select("id").eq("organization_id", organizationId).eq("is_active", true);
  if (error) throw new Error(`PRODUCT_DIAGNOSTIC_JOB_ACCOUNTS_LOOKUP_FAILED:${error.message}`);
  return (data ?? []).map((row) => row.id as string);
}

async function scheduleRetryOrFail(admin: ReturnType<typeof createAdminClient>, job: JobRow, errorCode: string, errorMessage: string) {
  if (job.attempt_count >= job.max_attempts) {
    await admin.from("product_diagnostic_jobs").update({ status: "failed", error_code: errorCode, error_message: errorMessage.slice(0, 500), completed_at: new Date().toISOString() }).eq("id", job.id);
    return;
  }
  await admin
    .from("product_diagnostic_jobs")
    .update({ status: "queued", next_attempt_at: new Date(Date.now() + retryDelaySeconds(job.attempt_count) * 1000).toISOString(), lease_id: null, lease_expires_at: null, error_code: errorCode, error_message: errorMessage.slice(0, 500) })
    .eq("id", job.id);
}

/** job.status='succeeded' only when a real diagnostic run (cache hit or new) actually succeeded — never when the run itself is 'failed'. Keeps job status a truthful observability signal instead of always reporting success once Claude was invoked. */
async function completeJobSucceeded(admin: ReturnType<typeof createAdminClient>, job: JobRow, diagnosticRunId: string) {
  await admin.from("product_diagnostic_jobs").update({ status: "succeeded", phase: "persist", diagnostic_run_id: diagnosticRunId, completed_at: new Date().toISOString() }).eq("id", job.id);
}

/** A structural failure (bad schema/request, model-output problem) never succeeds on blind retry — fail the job immediately regardless of attempts remaining, still linking the failed run for observability. */
async function completeJobFailedNonRetryable(admin: ReturnType<typeof createAdminClient>, job: JobRow, diagnosticRunId: string, errorCode: string, errorMessage: string) {
  await admin
    .from("product_diagnostic_jobs")
    .update({ status: "failed", phase: "persist", diagnostic_run_id: diagnosticRunId, error_code: errorCode, error_message: errorMessage.slice(0, 500), completed_at: new Date().toISOString() })
    .eq("id", job.id);
}

/** Claims and processes exactly one job. Single-job-per-invocation, matching the codebase's established "no concurrency" precedent (reduce_alert_dispatch_concurrency) — the worker route calls this once, not a burst loop. */
export async function processNextProductDiagnosticJob(): Promise<{ processed: boolean; jobId?: string }> {
  const admin = createAdminClient();
  const leaseId = randomUUID();
  const { data: claimedId, error: claimError } = await admin.rpc("claim_next_product_diagnostic_job", { requested_lease_id: leaseId, lease_duration_seconds: LEASE_DURATION_SECONDS });
  if (claimError) throw new Error(`PRODUCT_DIAGNOSTIC_JOB_CLAIM_FAILED:${claimError.message}`);
  if (!claimedId) return { processed: false };

  const { data: job, error: jobError } = await admin
    .from("product_diagnostic_jobs")
    .select("id,organization_id,product_id,requested_by,force,attempt_count,max_attempts")
    .eq("id", claimedId)
    .single<JobRow>();
  if (jobError || !job) throw new Error(`PRODUCT_DIAGNOSTIC_JOB_LOAD_FAILED:${jobError?.message}`);

  try {
    const allowedMlAccountIds = await resolveAllActiveMlAccountIds(job.organization_id);

    const built = await buildProductDiagnosticEvidenceV2ForProduct({
      organizationId: job.organization_id,
      productId: job.product_id,
      allowedMlAccountIds,
      forceMarketRefresh: job.force,
      userRequestedMarketResearch: job.force,
    });
    if (!built) {
      await admin.from("product_diagnostic_jobs").update({ status: "failed", error_code: "PRODUCT_NOT_FOUND", error_message: "Product not found for this organization.", completed_at: new Date().toISOString() }).eq("id", job.id);
      return { processed: true, jobId: job.id };
    }

    await admin.from("product_diagnostic_jobs").update({ phase: "claude", updated_at: new Date().toISOString() }).eq("id", job.id);

    const model = getProductDiagnosticModel();

    if (!job.force) {
      const { data: cached } = await admin
        .from("product_diagnostic_runs")
        .select("id")
        .eq("organization_id", job.organization_id)
        .eq("product_id", job.product_id)
        .eq("evidence_hash", built.evidenceHash)
        .eq("prompt_version", PRODUCT_DIAGNOSTIC_PROMPT_VERSION_V2)
        .eq("model", model)
        .eq("status", "succeeded")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (resolveDiagnosticCacheDecision({ hasCachedSuccess: Boolean(cached), force: job.force }) === "use_cache" && cached) {
        await completeJobSucceeded(admin, job, cached.id);
        return { processed: true, jobId: job.id };
      }
    }

    await admin
      .from("product_diagnostic_runs")
      .update({ status: "failed", error_code: "stale_running_timeout", error_message: "Worker did not complete within the expected time budget.", completed_at: new Date().toISOString() })
      .eq("organization_id", job.organization_id)
      .eq("product_id", job.product_id)
      .eq("status", "running")
      .lt("created_at", new Date(Date.now() - STALE_RUNNING_DIAGNOSTIC_RUN_MS).toISOString());

    const { data: runningRow, error: insertError } = await admin
      .from("product_diagnostic_runs")
      .insert({
        organization_id: job.organization_id,
        product_id: job.product_id,
        requested_by: job.requested_by,
        status: "running",
        diagnostic_trigger: "manual",
        evidence_version: PRODUCT_DIAGNOSTIC_EVIDENCE_VERSION_V2,
        evidence_hash: built.evidenceHash,
        prompt_version: PRODUCT_DIAGNOSTIC_PROMPT_VERSION_V2,
        model,
        evidence: built.evidence,
      })
      .select("id")
      .single();
    if (insertError) throw new Error(`PRODUCT_DIAGNOSTIC_RUN_LOCK_FAILED:${insertError.message}`);

    const outcome = await runProductDiagnosticV2({
      evidence: built.evidence,
      product: { sku: built.raw.product.sku, name: built.raw.product.name },
      asOfDate: built.raw.asOfDate,
      trigger: built.facts.sales.trigger,
      model,
      client: getAnthropicClient()?.messages,
    });

    if (outcome.ok) {
      await admin
        .from("product_diagnostic_runs")
        .update({
          status: "succeeded", result: outcome.result, anthropic_message_id: outcome.messageId,
          input_tokens: outcome.usage.inputTokens, output_tokens: outcome.usage.outputTokens,
          cache_creation_input_tokens: outcome.usage.cacheCreationInputTokens, cache_read_input_tokens: outcome.usage.cacheReadInputTokens,
          latency_ms: outcome.latencyMs, completed_at: new Date().toISOString(),
        })
        .eq("id", runningRow.id);
      console.log(JSON.stringify({ event: "product_diagnostic_v2_succeeded", productId: job.product_id, model, latencyMs: outcome.latencyMs }));
      await completeJobSucceeded(admin, job, runningRow.id);
      return { processed: true, jobId: job.id };
    }

    await admin
      .from("product_diagnostic_runs")
      .update({ status: "failed", error_code: outcome.errorCode, error_message: outcome.errorMessage, latency_ms: outcome.latencyMs, completed_at: new Date().toISOString() })
      .eq("id", runningRow.id);
    console.log(JSON.stringify({ event: "product_diagnostic_v2_failed", productId: job.product_id, model, errorCode: outcome.errorCode, retryable: outcome.retryable }));

    const action = resolveJobOutcomeAction({ diagnosticSucceeded: false, retryable: outcome.retryable });
    if (action === "retry_or_fail") {
      // 429/5xx/timeout — a fresh attempt (new evidence, new run row) may
      // succeed. scheduleRetryOrFail itself fails the job once max_attempts
      // is reached, so this never retries forever.
      await scheduleRetryOrFail(admin, job, outcome.errorCode, outcome.errorMessage);
    } else {
      // Structural (bad schema/request) or a model-output problem — never
      // retried, regardless of attempts remaining.
      await completeJobFailedNonRetryable(admin, job, runningRow.id, outcome.errorCode, outcome.errorMessage);
    }
    return { processed: true, jobId: job.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    await scheduleRetryOrFail(admin, job, "PRODUCT_DIAGNOSTIC_JOB_ERROR", message);
    throw error;
  }
}
