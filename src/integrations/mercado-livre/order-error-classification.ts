/*
 * Extracted from orders.ts (which has `import "server-only"` and so
 * can't be imported by tests) for the same reason sweepTargets got
 * its own file: this is pure classification logic worth testing
 * directly against 429/404/401 without mocking fetch through a
 * server-only import chain.
 */
export class MercadoLivreOrderRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly responseCode: string | null,
    public readonly responseMessage: string | null,
    public readonly retryable: boolean,
    public readonly notFound: boolean,
    public readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "MercadoLivreOrderRequestError";
  }
}

export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/*
 * 429/5xx: transient, retry via the job queue. 404: allow a short
 * retry first for eventual consistency right after a notification —
 * the caller decides when enough attempts have passed to treat it as
 * terminal. 401/403: never loop aggressively — auth/permission error.
 */
export function classifyOrderFetchFailure(status: number) {
  return {
    retryable: status === 429 || status >= 500 || status === 404,
    notFound: status === 404,
  };
}
