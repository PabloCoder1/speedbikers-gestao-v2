import type { AdminClient } from "@sb/db";

/**
 * Gravação em `sync_runs`/`sync_errors`, compartilhada por todo handler de
 * sincronização — L2 append-only, `docs/DATABASE.md` secao 4.
 */

export type SyncChannel = "webhook" | "reconciliation" | "backfill";
export type SyncResource = "orders" | "listings" | "fulfillment";
export type SyncErrorClass = "retryable" | "retryable_eventual" | "not_retryable";

interface SyncRunBase {
  organizationId: string;
  mlAccountId: string;
  jobId: string;
  resource: SyncResource;
  channel: SyncChannel;
  startedAt: Date;
  finishedAt: Date;
}

export async function recordSyncRunSuccess(
  db: AdminClient,
  params: SyncRunBase & { itemsProcessed: number; latestRecordAt: Date | null },
): Promise<void> {
  await db.from("sync_runs").insert({
    organization_id: params.organizationId,
    ml_account_id: params.mlAccountId,
    job_id: params.jobId,
    resource: params.resource,
    channel: params.channel,
    status: "done",
    items_processed: params.itemsProcessed,
    latest_record_at: params.latestRecordAt?.toISOString() ?? null,
    started_at: params.startedAt.toISOString(),
    finished_at: params.finishedAt.toISOString(),
  });
}

/**
 * Grava a `sync_run` como falha e o `sync_error` correspondente na mesma
 * chamada — as duas tabelas nascem separadas de propósito (`docs/DATABASE.md`
 * secao 4: uma execução pode falhar em vários itens sem falhar inteira), mas
 * aqui é sempre uma falha de execução inteira, então uma linha em cada.
 */
export async function recordSyncRunFailure(
  db: AdminClient,
  params: SyncRunBase & { reason: string; errorClass: SyncErrorClass },
): Promise<void> {
  const reason = params.reason.slice(0, 2000);

  const run = await db
    .from("sync_runs")
    .insert({
      organization_id: params.organizationId,
      ml_account_id: params.mlAccountId,
      job_id: params.jobId,
      resource: params.resource,
      channel: params.channel,
      status: "failed",
      reason,
      started_at: params.startedAt.toISOString(),
      finished_at: params.finishedAt.toISOString(),
    })
    .select("id")
    .maybeSingle();

  await db.from("sync_errors").insert({
    organization_id: params.organizationId,
    ml_account_id: params.mlAccountId,
    sync_run_id: run.data?.id ?? null,
    resource: params.resource,
    error_class: params.errorClass,
    message: reason,
    occurred_at: params.finishedAt.toISOString(),
  });
}
