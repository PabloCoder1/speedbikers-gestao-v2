import "server-only";

import { processNextOrdersBackfillBatch } from "@/features/ml-sync/process-orders-backfill-worker";
import { processNextOrdersDashboardBackfillBatch } from "@/features/ml-sync/process-orders-dashboard-backfill-worker";


const MAX_BATCHES_PER_INVOCATION =
  10;

const MAX_EXECUTION_TIME_MS =
  45_000;

export async function processOrdersBackfillBurst() {
  const startedAt =
    Date.now();


  const results:
    Record<
      string,
      unknown
    >[] = [];


  for (
    let batch = 0;
    batch <
    MAX_BATCHES_PER_INVOCATION;
    batch += 1
  ) {
    if (
      Date.now() -
        startedAt >=
      MAX_EXECUTION_TIME_MS
    ) {
      break;
    }


    /*
     * Priority 1:
     * complete the newest 90 days.
     */
    const priority =
      await processNextOrdersDashboardBackfillBatch();


    if (
      priority.processed
    ) {
      results.push({
        queue:
          "dashboard_90d",

        ...priority,
      });


      /*
       * Next loop still checks priority first.
       * This intentionally pauses the old
       * historical backfill until recent
       * coverage is completed.
       */
      continue;
    }


    /*
     * Priority 2:
     * resume the full historical backfill.
     */
    const historical =
      await processNextOrdersBackfillBatch();


    results.push({
      queue:
        "historical",

      ...historical,
    });


    if (
      !historical.processed
    ) {
      break;
    }
  }


  const processedCount =
    results.filter(
      (result) =>
        result.processed ===
        true,
    ).length;


  return {
    processed:
      processedCount > 0,

    batchesProcessed:
      processedCount,

    executionTimeMs:
      Date.now() -
      startedAt,

    results,
  };
}