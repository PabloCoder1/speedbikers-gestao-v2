import "server-only";

import { createClient } from "@/lib/supabase/server";

export type DashboardBackfillStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "partial"
  | "cancelled";

export type DashboardBackfillProgress = {
  id: string;
  mlAccountId: string;
  status: DashboardBackfillStatus;
  recordsDiscovered: number;
  recordsProcessed: number;
  recordsUpserted: number;
  retryCount: number;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
};

function isStatus(value: unknown): value is DashboardBackfillStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "partial" ||
    value === "cancelled"
  );
}

export async function getDashboardBackfillProgress(mlAccountIds: string[]) {
  const result: Record<string, DashboardBackfillProgress> = {};

  if (mlAccountIds.length === 0) {
    return result;
  }

  const supabase = await createClient();

  type SyncRunProgressRow = {
    id: string;
    ml_account_id: string;
    status: string;
    records_discovered: number;
    records_processed: number;
    records_upserted: number;
    retry_count: number;
    error_message: string | null;
    started_at: string;
    finished_at: string | null;
  };

  const { data, error } = await supabase
    .from("sync_runs")
    .select(
      [
        "id",
        "ml_account_id",
        "status",
        "records_discovered",
        "records_processed",
        "records_upserted",
        "retry_count",
        "error_message",
        "started_at",
        "finished_at",
      ].join(","),
    )
    .eq("sync_type", "orders_dashboard_backfill")
    .in("ml_account_id", mlAccountIds)
    .order("started_at", {
      ascending: false,
    })
    .returns<SyncRunProgressRow[]>();

  if (error) {
    throw new Error(
      "Não foi possível carregar o progresso da priorização do dashboard.",
    );
  }

  for (const row of data ?? []) {
    if (result[row.ml_account_id]) {
      continue;
    }

    if (!isStatus(row.status)) {
      continue;
    }

    result[row.ml_account_id] = {
      id: row.id,
      mlAccountId: row.ml_account_id,
      status: row.status,
      recordsDiscovered: row.records_discovered,
      recordsProcessed: row.records_processed,
      recordsUpserted: row.records_upserted,
      retryCount: row.retry_count,
      errorMessage: row.error_message,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  return result;
}
