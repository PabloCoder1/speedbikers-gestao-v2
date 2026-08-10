import "server-only";

import { createClient } from "@/lib/supabase/server";


export type ListingsSyncStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "partial"
  | "cancelled";


export type ListingsSyncProgress = {
  id: string;

  mlAccountId: string;

  status:
    ListingsSyncStatus;

  cursorOffset: number;

  batchSize: number;

  recordsDiscovered: number;

  recordsProcessed: number;

  recordsUpserted: number;

  retryCount: number;

  errorMessage: string | null;

  startedAt: string;

  finishedAt: string | null;
};

type ListingsSyncProgressRow = {
  id: string;
  ml_account_id: string;
  status: string;
  cursor_offset: number;
  batch_size: number;
  records_discovered: number;
  records_processed: number;
  records_upserted: number;
  retry_count: number;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
};

function isListingsSyncStatus(
  value: unknown,
): value is ListingsSyncStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "partial" ||
    value === "cancelled"
  );
}


export async function getListingsSyncProgress(
  mlAccountIds: string[],
) {
  const result:
    Record<
      string,
      ListingsSyncProgress
    > = {};


  if (
    mlAccountIds.length === 0
  ) {
    return result;
  }


  const supabase =
    await createClient();


  const {
    data,
    error,
  } = await supabase
    .from("sync_runs")
    .select(
      [
        "id",
        "ml_account_id",
        "status",
        "cursor_offset",
        "batch_size",
        "records_discovered",
        "records_processed",
        "records_upserted",
        "retry_count",
        "error_message",
        "started_at",
        "finished_at",
      ].join(","),
    )
    .eq(
      "sync_type",
      "listings_full",
    )
    .in(
      "ml_account_id",
      mlAccountIds,
    )
    .order(
      "started_at",
      {
        ascending: false,
      },
    ) as {
      data: ListingsSyncProgressRow[] | null;
      error: unknown;
    };


  if (error) {
    throw new Error(
      "Não foi possível carregar o progresso das sincronizações.",
    );
  }


  for (
    const row
    of data ?? []
  ) {
    if (
      result[
        row.ml_account_id
      ]
    ) {
      continue;
    }


    if (
      !isListingsSyncStatus(
        row.status,
      )
    ) {
      continue;
    }


    result[
      row.ml_account_id
    ] = {
      id:
        row.id,

      mlAccountId:
        row.ml_account_id,

      status:
        row.status,

      cursorOffset:
        row.cursor_offset,

      batchSize:
        row.batch_size,

      recordsDiscovered:
        row.records_discovered,

      recordsProcessed:
        row.records_processed,

      recordsUpserted:
        row.records_upserted,

      retryCount:
        row.retry_count,

      errorMessage:
        row.error_message,

      startedAt:
        row.started_at,

      finishedAt:
        row.finished_at,
    };
  }


  return result;
}