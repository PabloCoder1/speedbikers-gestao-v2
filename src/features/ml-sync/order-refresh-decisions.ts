import { MercadoLivreOrderRequestError } from "@/integrations/mercado-livre/order-error-classification";

/*
 * Pure retry/requeue decisions for process-order-refresh-job.ts,
 * extracted to their own server-only-free file so they're directly
 * testable (order-refresh-retry.test.ts) — process-order-refresh-job.ts
 * itself has `import "server-only"` in its transitive dependency chain
 * (createAdminClient, getValidMercadoLivreAccessToken) and can't be
 * imported by tests.
 */

export const MAX_FETCH_ATTEMPTS = 3;

export function retrySeconds(attempt: number) {
  return Math.min(
    30 * 2 ** Math.max(0, attempt - 1) + Math.floor(Math.random() * 16),
    15 * 60,
  );
}

/*
 * Given the error getSellerOrder threw and how many fetch attempts
 * have already run inside THIS invocation, should we retry again
 * right now? Bounded to MAX_FETCH_ATTEMPTS so a single worker call can
 * never block for long — anything beyond that goes back to the job
 * queue's own next_attempt_at/attempt_count backoff, across separate
 * invocations.
 */
export function shouldRetryFetchWithinInvocation({
  error,
  fetchAttempt,
}: {
  error: unknown;
  fetchAttempt: number;
}): boolean {
  if (fetchAttempt >= MAX_FETCH_ATTEMPTS) {
    return false;
  }
  if (!(error instanceof MercadoLivreOrderRequestError)) {
    return false;
  }
  return error.retryable;
}

/*
 * After persisting a fetched order, did another notification arrive
 * while we were processing it? If so the job must go back to
 * 'queued' instead of 'succeeded', or the update it carried would be
 * silently lost.
 */
export function shouldRequeueAfterRevisionBump({
  capturedRevision,
  currentRevision,
}: {
  capturedRevision: number;
  currentRevision: number;
}): boolean {
  return currentRevision > capturedRevision;
}

export function classifyErrorCode(error: unknown): string {
  if (error instanceof MercadoLivreOrderRequestError) {
    if (error.notFound) return "order_not_found";
    if (error.status === 401 || error.status === 403) return "order_auth_failed";
  }
  return "order_refresh_failed";
}
