import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { fetchSupportQuestions } from "./ml-support-questions-fetch.js";
import { ensureAccessToken } from "./ml-token.js";
import { recordSyncRunFailure, recordSyncRunSuccess } from "./sync-runs.js";

/**
 * `sync.support.questions.reconcile` — rede de segurança do webhook `questions`
 * (D-089, Fase 7B). Mesmo formato de `sync.listing-visits.snapshot`.
 *
 * `resource: "questions"` — primeiro uso do valor, precisou alargar o CHECK de
 * `sync_runs`/`sync_errors` (`20260825180000_add_questions_sync_resource.sql`).
 * D-087 deliberadamente NÃO alargou esse CHECK para `sync.support.questions`:
 * um fetch por ID não tem janela, contagem nem frescor. Esta varredura tem.
 *
 * Job SEPARADO de `sync.support.questions`, não uma flag no mesmo handler: os
 * dois têm payload, retry e semântica de erro diferentes (um ID que falha
 * contra uma varredura que falha) e só um deles alimenta `sync_runs`.
 */

const payloadSchema = z.object({ mlAccountId: z.uuid() });

export interface SyncSupportQuestionsReconcileDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
}

export function createSyncSupportQuestionsReconcileHandler(
  deps: SyncSupportQuestionsReconcileDeps,
): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem mlAccountId" };
    }

    const { mlAccountId } = parsed.data;
    const now = deps.now?.() ?? new Date();

    const account = await deps.db
      .from("ml_accounts")
      .select("id, organization_id, seller_id, status")
      .eq("id", mlAccountId)
      .maybeSingle();

    if (account.error !== null || account.data === null) {
      context.logger.warn("sync_support_questions_reconcile_account_missing", {
        ml_account_id: mlAccountId,
      });

      return { status: "done", processed: 0 };
    }

    if (account.data.status !== "CONNECTED") {
      context.logger.info("sync_support_questions_reconcile_account_not_connected", {
        ml_account_id: mlAccountId,
      });

      return { status: "done", processed: 0 };
    }

    const { organization_id: organizationId, seller_id: sellerId } = account.data;

    if (sellerId === null) {
      // Mesma fronteira de D-087: sem `seller_id` não há como conferir que a
      // pergunta pertence a esta conta, e reprocessar não cria o campo.
      return { status: "failed", retryable: false, reason: "conta CONNECTED sem seller_id" };
    }

    const started = now;
    const tokenResult = await ensureAccessToken(deps, mlAccountId, now);

    if (!tokenResult.ok) {
      await recordSyncRunFailure(deps.db, {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        resource: "questions",
        channel: "reconciliation",
        startedAt: started,
        finishedAt: deps.now?.() ?? new Date(),
        reason: tokenResult.reason,
        errorClass: tokenResult.retryable ? "retryable" : "not_retryable",
      }, context.logger);

      return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
    }

    let result;

    try {
      result = await fetchSupportQuestions({
        db: deps.db,
        organizationId,
        mlAccountId,
        sellerId,
        mercadoLivre: deps.mercadoLivre,
        accessToken: tokenResult.accessToken,
        logger: context.logger,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      });
    } catch (error) {
      const finishedAt = deps.now?.() ?? new Date();
      const errorClass = error instanceof MercadoLivreApiError ? error.errorClass : "retryable";
      const reason =
        error instanceof Error ? error.message : "erro desconhecido ao reconciliar perguntas";

      await recordSyncRunFailure(deps.db, {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        resource: "questions",
        channel: "reconciliation",
        startedAt: started,
        finishedAt,
        reason,
        errorClass,
      }, context.logger);

      return { status: "failed", retryable: errorClass !== "not_retryable", reason };
    }

    const finishedAt = deps.now?.() ?? new Date();
    // Truncar a varredura também conta como parcial: o resultado é honesto
    // sobre não ter coberto tudo, em vez de reportar "done" sobre um recorte.
    const partial = result.itemsFailed > 0 || result.itemsRejected > 0 || result.truncated;

    const reasons: string[] = [];

    if (result.itemsFailed > 0) {
      reasons.push(`${String(result.itemsFailed)} pergunta(s) falharam ao persistir`);
    }

    if (result.itemsRejected > 0) {
      reasons.push(`${String(result.itemsRejected)} pergunta(s) recusadas por seller_id divergente`);
    }

    if (result.truncated) {
      reasons.push(`varredura truncada no teto de páginas (total remoto: ${String(result.remoteTotal)})`);
    }

    await recordSyncRunSuccess(deps.db, {
      organizationId,
      mlAccountId,
      jobId: envelope.jobId,
      resource: "questions",
      channel: "reconciliation",
      itemsProcessed: result.itemsProcessed,
      latestRecordAt: finishedAt,
      startedAt: started,
      finishedAt,
      status: partial ? "partial" : "done",
      ...(partial ? { reason: reasons.join("; ") } : {}),
    }, context.logger);

    context.logger.info("sync_support_questions_reconcile_done", {
      ml_account_id: mlAccountId,
      items_processed: result.itemsProcessed,
      items_failed: result.itemsFailed,
      items_rejected: result.itemsRejected,
      remote_total: result.remoteTotal,
      truncated: result.truncated,
    });

    return { status: "done", processed: result.itemsProcessed };
  };
}
