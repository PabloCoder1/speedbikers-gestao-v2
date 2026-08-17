import "server-only";

import {
  randomUUID,
} from "node:crypto";

import { syncOrdersPreview } from "@/features/ml-sync/sync-orders-preview";
import { nextSaoPauloDayStartIso } from "@/lib/date/sao-paulo";
import { createAdminClient } from "@/lib/supabase/admin";


const LEASE_SECONDS =
  180;


type SyncRunRow = {
  id: string;

  organization_id: string;

  ml_account_id: string;

  cursor_offset: number;

  batch_size: number;

  records_discovered: number;

  records_processed: number;

  records_upserted: number;

  retry_count: number;

  max_retries: number;

  metadata: unknown;
};


function asMetadata(
  value: unknown,
): Record<string, unknown> {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return value as
      Record<string, unknown>;
  }

  return {};
}


function getMetadataString(
  metadata:
    Record<string, unknown>,
  key: string,
) {
  const value =
    metadata[key];

  return typeof value ===
    "string"
    ? value
    : null;
}


function getMetadataNumber(
  metadata:
    Record<string, unknown>,
  key: string,
) {
  const value =
    metadata[key];

  return typeof value ===
      "number" &&
    Number.isFinite(value)
    ? value
    : null;
}


function earlierDate(
  left: string,
  right: string,
) {
  return Date.parse(left) <
    Date.parse(right)
    ? left
    : right;
}


function retryDelaySeconds(
  retryCount: number,
) {
  return Math.min(
    30 *
      Math.pow(
        2,
        Math.max(
          retryCount - 1,
          0,
        ),
      ),

    15 * 60,
  );
}


export async function processNextOrdersBackfillBatch() {
  const admin =
    createAdminClient();


  const leaseId =
    randomUUID();


  const {
    data: syncRunId,
    error: claimError,
  } = await admin.rpc(
    "claim_next_orders_backfill_run",
    {
      requested_lease_id:
        leaseId,

      lease_duration_seconds:
        LEASE_SECONDS,
    },
  );


  if (claimError) {
    throw new Error(
      "Não foi possível adquirir o próximo backfill de pedidos.",
    );
  }


  if (!syncRunId) {
    return {
      processed: false,
      reason:
        "queue_empty",
    } as const;
  }


  const {
    data,
    error: runError,
  } = (await admin
    .from("sync_runs")
    .select(
      [
        "id",
        "organization_id",
        "ml_account_id",
        "cursor_offset",
        "batch_size",
        "records_discovered",
        "records_processed",
        "records_upserted",
        "retry_count",
        "max_retries",
        "metadata",
      ].join(","),
    )
    .eq(
      "id",
      syncRunId,
    )
    .eq(
      "lease_id",
      leaseId,
    )
    .maybeSingle()) as {
      data: SyncRunRow | null;
      error: unknown;
    };


  if (
    runError ||
    !data
  ) {
    throw new Error(
      "O backfill foi adquirido, mas não pôde ser carregado.",
    );
  }


  const run =
    data;


  const metadata =
    asMetadata(
      run.metadata,
    );


  const windowFrom =
    getMetadataString(
      metadata,
      "window_from",
    );


  const windowTo =
    getMetadataString(
      metadata,
      "window_to",
    );


  const historyUntil =
    getMetadataString(
      metadata,
      "history_until",
    );


  if (
    !windowFrom ||
    !windowTo ||
    !historyUntil
  ) {
    throw new Error(
      "O backfill não possui uma janela histórica válida.",
    );
  }


  try {
    const result =
      await syncOrdersPreview({
        organizationId:
          run.organization_id,

        mlAccountId:
          run.ml_account_id,

        syncType:
          "orders_backfill",

        limit:
          run.batch_size,

        offset:
          run.cursor_offset,

        dateCreatedFrom:
          windowFrom,

        dateCreatedTo:
          windowTo,

        existingSyncRunId:
          run.id,

        manageRunLifecycle:
          false,
      });


    const newOffset =
      run.cursor_offset +
      result.pageOrders;


    const newProcessed =
      run.records_processed +
      result.pageOrders;


    const newUpserted =
      run.records_upserted +
      result.importedOrders;


    const windowComplete =
      result.pageOrders === 0 ||
      newOffset >=
        result.sellerTotal;


    const completedWindows =
      getMetadataNumber(
        metadata,
        "completed_windows",
      ) ?? 0;


    const baseMetadata = {
      ...metadata,

      current_window_total:
        result.sellerTotal,

      last_batch_offset:
        run.cursor_offset,

      last_batch_orders:
        result.pageOrders,

      last_batch_items:
        result.importedItems,

      last_batch_mapped:
        result.mappedItems,

      last_batch_unmapped:
        result.unmappedItems,

      last_token_refreshed:
        result.tokenRefreshed,

      last_batch_finished_at:
        new Date()
          .toISOString(),
    };


    /*
     * More pages remain inside
     * this same date window.
     */
    if (!windowComplete) {
      const {
        error:
          checkpointError,
      } = await admin
        .from("sync_runs")
        .update({
          status:
            "queued",

          cursor_offset:
            newOffset,

          records_processed:
            newProcessed,

          records_upserted:
            newUpserted,

          retry_count:
            0,

          next_attempt_at:
            new Date()
              .toISOString(),

          lease_id:
            null,

          lease_expires_at:
            null,

          error_code:
            null,

          error_message:
            null,

          metadata:
            baseMetadata,
        })
        .eq(
          "id",
          run.id,
        )
        .eq(
          "lease_id",
          leaseId,
        );


      if (checkpointError) {
        throw new Error(
          "O lote foi importado, mas o checkpoint do backfill falhou.",
        );
      }


      return {
        processed: true,
        completed: false,

        syncRunId:
          run.id,

        windowFrom,
        windowTo,

        cursorOffset:
          newOffset,

        windowTotal:
          result.sellerTotal,

        totalProcessed:
          newProcessed,
      } as const;
    }


    /*
     * The current date window ended.
     */
    const nextWindowFrom =
      windowTo;


    /*
     * If the current upper bound reached
     * the immutable historical snapshot,
     * the whole backfill is finished.
     */
    if (
      Date.parse(
        nextWindowFrom,
      ) >=
      Date.parse(
        historyUntil,
      )
    ) {
      const {
        error:
          finalError,
      } = await admin
        .from("sync_runs")
        .update({
          status:
            "succeeded",

          cursor_offset:
            newOffset,

          records_processed:
            newProcessed,

          records_upserted:
            newUpserted,

          retry_count:
            0,

          lease_id:
            null,

          lease_expires_at:
            null,

          error_code:
            null,

          error_message:
            null,

          finished_at:
            new Date()
              .toISOString(),

          metadata: {
            ...baseMetadata,

            completed_windows:
              completedWindows +
              1,

            completed_at:
              new Date()
                .toISOString(),
          },
        })
        .eq(
          "id",
          run.id,
        )
        .eq(
          "lease_id",
          leaseId,
        );


      if (finalError) {
        throw new Error(
          "O histórico terminou, mas não foi possível finalizar o backfill.",
        );
      }


      return {
        processed: true,
        completed: true,

        syncRunId:
          run.id,

        totalProcessed:
          newProcessed,
      } as const;
    }


    const nextWindowTo =
      earlierDate(
        nextSaoPauloDayStartIso(nextWindowFrom),

        historyUntil,
      );


    const {
      error:
        nextWindowError,
    } = await admin
      .from("sync_runs")
      .update({
        status:
          "queued",

        cursor_offset:
          0,

        records_processed:
          newProcessed,

        records_upserted:
          newUpserted,

        retry_count:
          0,

        next_attempt_at:
          new Date()
            .toISOString(),

        lease_id:
          null,

        lease_expires_at:
          null,

        error_code:
          null,

        error_message:
          null,

        metadata: {
          ...baseMetadata,

          completed_windows:
            completedWindows +
            1,

          window_from:
            nextWindowFrom,

          window_to:
            nextWindowTo,

          current_window_total:
            null,
        },
      })
      .eq(
        "id",
        run.id,
      )
      .eq(
        "lease_id",
        leaseId,
      );


    if (nextWindowError) {
      throw new Error(
        "Não foi possível avançar para a próxima janela histórica.",
      );
    }


    return {
      processed: true,
      completed: false,

      syncRunId:
        run.id,

      completedWindow: {
        from:
          windowFrom,

        to:
          windowTo,
      },

      nextWindow: {
        from:
          nextWindowFrom,

        to:
          nextWindowTo,
      },

      totalProcessed:
        newProcessed,
    } as const;
  } catch (error) {
    const nextRetry =
      run.retry_count + 1;


    const failed =
      nextRetry >
      run.max_retries;


    const delaySeconds =
      retryDelaySeconds(
        nextRetry,
      );


    await admin
      .from("sync_runs")
      .update({
        status:
          failed
            ? "failed"
            : "queued",

        retry_count:
          nextRetry,

        next_attempt_at:
          new Date(
            Date.now() +
              delaySeconds *
                1000,
          ).toISOString(),

        lease_id:
          null,

        lease_expires_at:
          null,

        error_code:
          "orders_backfill_batch_failed",

        error_message:
          error instanceof Error
            ? error.message
            : "Erro desconhecido.",

        finished_at:
          failed
            ? new Date()
                .toISOString()
            : null,
      })
      .eq(
        "id",
        run.id,
      )
      .eq(
        "lease_id",
        leaseId,
      );


    throw error;
  }
}
