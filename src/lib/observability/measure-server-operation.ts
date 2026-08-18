import "server-only";

const SLOW_THRESHOLD_MS = 1500;

/*
 * Vercel logs already cover slow requests — this only exists so a
 * slow read model is grep-able as structured JSON instead of buried
 * in a request trace. Never logs tokens, SQL, or raw payloads: just
 * the operation name and elapsed time.
 */
export async function measureServerOperation<T>(
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= SLOW_THRESHOLD_MS) {
      console.warn(
        JSON.stringify({ event: "slow_read_model", operation, elapsedMs }),
      );
    }
  }
}
