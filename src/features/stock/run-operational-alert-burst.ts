/*
 * Pure bounded-loop logic for the operational alert burst, extracted
 * to its own server-only-free file — process-operational-alert-burst.ts
 * imports processNextOperationalAlertJob, which has `import
 * "server-only"` in its chain, so it can't be imported by tests.
 */

type OperationalAlertJobResult =
  | { processed: false; reason: string }
  | { processed: true; jobId: string; result: unknown };

const DEFAULT_MAX_JOBS_PER_BURST = 20;
const DEFAULT_TIME_BUDGET_MS = 40_000;

export async function runOperationalAlertBurst({
  processJob,
  maxJobs = DEFAULT_MAX_JOBS_PER_BURST,
  timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
}: {
  processJob: () => Promise<OperationalAlertJobResult>;
  maxJobs?: number;
  timeBudgetMs?: number;
}) {
  const startedAt = Date.now();
  let processedCount = 0;
  let succeededCount = 0;
  let failedCount = 0;

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
      succeededCount += 1;
    } catch (error) {
      // The job itself already checkpointed its own retry/failure
      // state before rethrowing — one product's evaluation blowing up
      // must not stop the rest of the burst.
      processedCount += 1;
      failedCount += 1;
      console.error(
        "Operational alert burst: job failed, continuing.",
        error instanceof Error ? error.message : "unknown_error",
      );
    }
  }

  return {
    processed: processedCount > 0,
    processedCount,
    succeededCount,
    failedCount,
    executionTimeMs: Date.now() - startedAt,
  } as const;
}
