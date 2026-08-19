const RETRY_BASE_SECONDS = 30;
const RETRY_CAP_SECONDS = 900;

/** Same jittered-exponential formula used by every job queue in this codebase (30s base, doubling, up to 16s jitter, capped at 15min). Pure so it's testable without a DB. */
export function retryDelaySeconds(attempt: number) {
  return Math.min(RETRY_BASE_SECONDS * 2 ** Math.max(0, attempt - 1) + Math.floor(Math.random() * 16), RETRY_CAP_SECONDS);
}
