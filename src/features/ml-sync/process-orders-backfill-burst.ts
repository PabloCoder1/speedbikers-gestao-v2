import "server-only";

import { processNextOrdersBackfillBatch } from "@/features/ml-sync/process-orders-backfill-worker";


const MAX_BATCHES_PER_INVOCATION =
  5;


/*
 * Safety budget.
 *
 * We do not want one HTTP invocation to remain
 * alive indefinitely even if the queue contains
 * thousands of pages.
 */
const MAX_EXECUTION_TIME_MS =
  25_000;


export async function processOrdersBackfillBurst() {
  const startedAt =
    Date.now();


  const results: Awaited<
    ReturnType<
      typeof processNextOrdersBackfillBatch
    >
  >[] = [];


  for (
    let batch = 0;
    batch <
    MAX_BATCHES_PER_INVOCATION;
    batch += 1
  ) {
    /*
     * Leave margin before continuing with
     * another network/database batch.
     */
    if (
      Date.now() -
        startedAt >=
      MAX_EXECUTION_TIME_MS
    ) {
      break;
    }


    const result =
      await processNextOrdersBackfillBatch();


    results.push(
      result,
    );


    /*
     * Nothing available anymore.
     */
    if (
      !result.processed
    ) {
      break;
    }


    /*
     * Full historical backfill completed.
     */
    if (
      "completed" in result &&
      result.completed
    ) {
      break;
    }
  }


  const processedResults =
    results.filter(
      (result) =>
        result.processed,
    );


  const lastResult =
    results[
      results.length - 1
    ] ?? null;


  return {
    processed:
      processedResults.length >
      0,

    batchesProcessed:
      processedResults.length,

    executionTimeMs:
      Date.now() -
      startedAt,

    lastResult,
  };
}
