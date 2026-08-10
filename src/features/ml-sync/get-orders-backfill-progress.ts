import "server-only";

import { createClient } from "@/lib/supabase/server";

export type OrdersBackfillStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "partial"
  | "cancelled";

export type OrdersBackfillProgress = {
  id: string;
  mlAccountId: string;
  status: OrdersBackfillStatus;
  recordsDiscovered: number;
  recordsProcessed: number;
  recordsUpserted: number;
  retryCount: number;
  errorMessage: string | null;
  historyFrom: string | null;
  historyUntil: string | null;
  windowFrom: string | null;
  windowTo: string | null;
  startedAt: string;
  finishedAt: string | null;
};

function metadataString(metadata: unknown, key: string) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const value = (metadata as Record<string, unknown>)[key];

  return typeof value === "string" ? value : null;
}

function isStatus(value: unknown): value is OrdersBackfillStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "partial" ||
    value === "cancelled"
  );
}

export async function getOrdersBackfillProgress(mlAccountIds: string[]) {
  const result: Record<string, OrdersBackfillProgress> = {};

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
    metadata: unknown;
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
        "metadata",
        "started_at",
        "finished_at",
      ].join(","),
    )
    .eq("sync_type", "orders_backfill")
    .in("ml_account_id", mlAccountIds)
    .order("started_at", {
      ascending: false,
    })
    .returns<SyncRunProgressRow[]>();

  if (error) {
    throw new Error(
      "Não foi possível carregar o progresso do histórico de pedidos.",
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
      historyFrom: metadataString(row.metadata, "history_from"),
      historyUntil: metadataString(row.metadata, "history_until"),
      windowFrom: metadataString(row.metadata, "window_from"),
      windowTo: metadataString(row.metadata, "window_to"),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  return result;
}