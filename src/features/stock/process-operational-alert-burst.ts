import "server-only";

import { processNextOperationalAlertJob } from "./process-operational-alert-job";
import { runOperationalAlertBurst } from "./run-operational-alert-burst";

/*
 * Processes a bounded batch of operational_alert_jobs per worker
 * invocation instead of one job per HTTP call — a full reconciliation
 * enqueues one job per product (thousands), and 1 job/minute would
 * never drain it. Sequential on purpose, same reasoning as
 * processOrderRefreshBurst: this stage doesn't need concurrency to hit
 * its throughput target, and evaluating 20 products in parallel adds
 * risk for no measured benefit yet.
 *
 * The bounded-loop logic itself lives in run-operational-alert-burst.ts
 * (pure, unit tested) — this file only wires the real job processor in.
 */
export async function processOperationalAlertBurst({
  processJob = processNextOperationalAlertJob,
  maxJobs,
  timeBudgetMs,
}: {
  processJob?: typeof processNextOperationalAlertJob;
  maxJobs?: number;
  timeBudgetMs?: number;
} = {}) {
  return runOperationalAlertBurst({ processJob, maxJobs, timeBudgetMs });
}
