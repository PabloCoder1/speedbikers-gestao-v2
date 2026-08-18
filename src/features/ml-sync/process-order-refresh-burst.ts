import "server-only";

import { processNextOrderRefreshJob } from "./process-order-refresh-job";
import { runOrderRefreshBurst } from "./run-order-refresh-burst";
import { refreshStockSaleDeductions } from "@/features/stock/refresh-stock-sale-deductions";

/*
 * Processes a bounded batch of ml_order_refresh_jobs per worker
 * invocation instead of one job per HTTP call — a full reconciliation
 * can enqueue thousands of order notifications, and 1 job/minute would
 * never catch up. Sequential on purpose (ML rate limits, and each job
 * already does its own bounded retry loop); parallelism is not needed
 * at this stage's throughput.
 *
 * The bounded-loop logic itself lives in run-order-refresh-burst.ts
 * (pure, unit tested) — this file only wires the real job processor
 * and the real stock-deductions refresh in.
 */
export async function processOrderRefreshBurst({
  processJob = processNextOrderRefreshJob,
  refreshDeductions = refreshStockSaleDeductions,
  maxJobs,
  timeBudgetMs,
}: {
  processJob?: typeof processNextOrderRefreshJob;
  refreshDeductions?: () => Promise<void>;
  maxJobs?: number;
  timeBudgetMs?: number;
} = {}) {
  return runOrderRefreshBurst({ processJob, refreshDeductions, maxJobs, timeBudgetMs });
}
