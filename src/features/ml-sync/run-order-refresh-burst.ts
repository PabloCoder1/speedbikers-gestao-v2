/*
 * Pure bounded-loop logic for the order refresh burst, extracted to
 * its own server-only-free file — process-order-refresh-burst.ts
 * imports processNextOrderRefreshJob and createAdminClient, both of
 * which have `import "server-only"` in their chain, so they can't be
 * imported by tests.
 */

type OrderRefreshJobResult =
  | { processed: false; reason: string }
  | {
      processed: true;
      status: "succeeded" | "requeued";
      orderId: string;
      changed: boolean;
    };

const DEFAULT_MAX_JOBS_PER_BURST = 15;
const DEFAULT_TIME_BUDGET_MS = 42_000;

/*
 * refresh_stock_sale_deductions() runs at most ONCE per burst, only if
 * something actually changed, same pattern as sync-recent-orders.ts —
 * never once per order.
 */
export async function runOrderRefreshBurst({
  processJob,
  refreshDeductions,
  maxJobs = DEFAULT_MAX_JOBS_PER_BURST,
  timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
}: {
  processJob: () => Promise<OrderRefreshJobResult>;
  refreshDeductions: () => Promise<void>;
  maxJobs?: number;
  timeBudgetMs?: number;
}) {
  const startedAt = Date.now();
  let processedCount = 0;
  let succeededCount = 0;
  let requeuedCount = 0;
  let failedCount = 0;
  let anyOrderChanged = false;

  for (
    let i = 0;
    i < maxJobs && Date.now() - startedAt < timeBudgetMs;
    i++
  ) {
    try {
      const result = await processJob();
      if (!result.processed) {
        break;
      }
      processedCount += 1;
      if (result.status === "succeeded") {
        succeededCount += 1;
      } else if (result.status === "requeued") {
        requeuedCount += 1;
      }
      if (result.changed) {
        anyOrderChanged = true;
      }
    } catch (error) {
      // The job itself already checkpointed its own retry/failure
      // state before rethrowing (process-order-refresh-job.ts) — one
      // order blowing up must not stop the rest of the burst.
      processedCount += 1;
      failedCount += 1;
      console.error(
        "Order refresh burst: job failed, continuing.",
        error instanceof Error ? error.message : "unknown_error",
      );
    }
  }

  if (anyOrderChanged) {
    await refreshDeductions();
  }

  return {
    processed: processedCount > 0,
    processedCount,
    succeededCount,
    requeuedCount,
    failedCount,
    stockDeductionsRefreshed: anyOrderChanged,
    executionTimeMs: Date.now() - startedAt,
  } as const;
}
