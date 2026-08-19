const RETRY_BASE_SECONDS = 30;
const RETRY_CAP_SECONDS = 900;

/** Same jittered-exponential formula used by every job queue in this codebase (30s base, doubling, up to 16s jitter, capped at 15min). Pure so it's testable without a DB. */
export function retryDelaySeconds(attempt: number) {
  return Math.min(RETRY_BASE_SECONDS * 2 ** Math.max(0, attempt - 1) + Math.floor(Math.random() * 16), RETRY_CAP_SECONDS);
}

/**
 * Hotfix 36.1 (job status semantics): a job succeeds ONLY when a real
 * diagnostic run actually succeeded (cache hit or a new one) — never just
 * because Claude was invoked. A failed run either gets a normal
 * retry/backoff (429/5xx/timeout) or fails the job immediately for a
 * structural/model-output problem that would never succeed on blind retry.
 */
export function resolveJobOutcomeAction(params: { diagnosticSucceeded: boolean; retryable: boolean }): "succeeded" | "failed_non_retryable" | "retry_or_fail" {
  if (params.diagnosticSucceeded) return "succeeded";
  return params.retryable ? "retry_or_fail" : "failed_non_retryable";
}
