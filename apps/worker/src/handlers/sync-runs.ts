import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";

/**
 * Gravação em `sync_runs`/`sync_errors`, compartilhada por todo handler de
 * sincronização — L2 append-only, `docs/DATABASE.md` secao 4.
 *
 * Falha ao gravar aqui é logada, nunca lançada: isto é observabilidade da
 * sincronização, não o resultado dela — abortar um job cuja sincronização
 * já terminou (bem ou mal) só porque o LOG dela falhou trocaria um problema
 * pequeno (Sync Health incompleto) por um maior (job retryable reprocessando
 * trabalho que já tinha terminado). D-067 (achado: a falha aqui era
 * completamente invisível antes, nem logada).
 */

export type SyncChannel = "webhook" | "reconciliation" | "backfill";
/**
 * Espelho em TypeScript do CHECK de `sync_runs.resource`/`sync_errors.resource`.
 * Os dois precisam andar juntos: `questions` entrou em
 * `20260825180000_add_questions_sync_resource.sql` (D-089).
 */
export type SyncResource = "orders" | "listings" | "fulfillment" | "visits" | "questions";
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

/**
 * `status: "partial"` é para quando a execução terminou (não é falha
 * retryable) mas nem tudo pôde ser processado — ex.: uma order com formato
 * inesperado no meio da página (`ml-orders-fetch.ts`). A constraint
 * `sync_runs_reason_matches_status` exige `reason` sempre que o status não
 * for `done`.
 */
export async function recordSyncRunSuccess(
  db: AdminClient,
  params: SyncRunBase & {
    itemsProcessed: number;
    latestRecordAt: Date | null;
    status?: "done" | "partial";
    reason?: string;
  },
  logger: Logger,
): Promise<void> {
  const result = await db.from("sync_runs").insert({
    organization_id: params.organizationId,
    ml_account_id: params.mlAccountId,
    job_id: params.jobId,
    resource: params.resource,
    channel: params.channel,
    status: params.status ?? "done",
    reason: params.reason?.slice(0, 2000) ?? null,
    items_processed: params.itemsProcessed,
    latest_record_at: params.latestRecordAt?.toISOString() ?? null,
    started_at: params.startedAt.toISOString(),
    finished_at: params.finishedAt.toISOString(),
  });

  if (result.error !== null) {
    logger.error("sync_run_not_recorded", {
      job_id: params.jobId,
      resource: params.resource,
      reason: result.error.message,
    });
  }
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
  logger: Logger,
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

  if (run.error !== null) {
    logger.error("sync_run_failure_not_recorded", {
      job_id: params.jobId,
      resource: params.resource,
      reason: run.error.message,
    });
  }

  const errorInsert = await db.from("sync_errors").insert({
    organization_id: params.organizationId,
    ml_account_id: params.mlAccountId,
    sync_run_id: run.data?.id ?? null,
    resource: params.resource,
    error_class: params.errorClass,
    message: reason,
    occurred_at: params.finishedAt.toISOString(),
  });

  if (errorInsert.error !== null) {
    logger.error("sync_error_not_recorded", {
      job_id: params.jobId,
      resource: params.resource,
      reason: errorInsert.error.message,
    });
  }
}
