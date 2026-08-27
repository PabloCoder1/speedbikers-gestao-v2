import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { ensureAccessToken } from "./ml-token.js";
import { fetchSupportClaims } from "./ml-support-claims-fetch.js";
import { recordSyncRunFailure, recordSyncRunSuccess } from "./sync-runs.js";

/**
 * `sync.support.claims.reconcile` — rede de segurança do webhook
 * `post_purchase` (D-108, Fase 7B). Fecha a lacuna que D-104 deixou aberta:
 * até aqui, notificação perdida era claim perdido para sempre.
 *
 * **Esta varredura tem checkpoint DE VERDADE**, diferente da de Perguntas: a
 * busca de reclamações aceita `range=last_updated:after:...`, então
 * `sync_runs.latest_record_at` volta a ser o que sempre foi nos jobs de
 * pedido — o ponto de onde continuar —, em vez do carimbo informativo que
 * D-089 precisou aceitar.
 */

const payloadSchema = z.object({ mlAccountId: z.uuid() });

/** Janela inicial quando ainda não existe checkpoint, e piso de segurança. */
const FALLBACK_WINDOW_DAYS = 7;
/**
 * Recuo aplicado ao checkpoint. `last_updated` é o relógio do Mercado Livre e
 * a busca é por `after` estrito: sem a sobreposição, um claim atualizado no
 * mesmo instante do corte cairia entre duas execuções. Reprocessar é
 * inofensivo — a persistência é idempotente.
 */
const OVERLAP_MINUTES = 10;

/** A API recusa data sem milissegundos (400). Formato exigido, não estético. */
function toMercadoLivreInstant(value: Date): string {
  return `${value.toISOString().slice(0, -1)}+00:00`;
}

export interface SyncSupportClaimsReconcileDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
}

export function createSyncSupportClaimsReconcileHandler(
  deps: SyncSupportClaimsReconcileDeps,
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
      context.logger.warn("sync_support_claims_reconcile_account_missing", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    if (account.data.status !== "CONNECTED") {
      context.logger.info("sync_support_claims_reconcile_account_not_connected", {
        ml_account_id: mlAccountId,
      });

      return { status: "done", processed: 0 };
    }

    const { organization_id: organizationId, seller_id: sellerId } = account.data;

    if (sellerId === null) {
      // `players.user_id` é o filtro base exigido pela API: sem `seller_id`
      // não existe consulta válida, e reprocessar não cria o campo.
      return { status: "failed", retryable: false, reason: "conta CONNECTED sem seller_id" };
    }

    const checkpoint = await deps.db
      .from("sync_runs")
      .select("latest_record_at")
      .eq("ml_account_id", mlAccountId)
      .eq("resource", "claims")
      .not("latest_record_at", "is", null)
      .order("latest_record_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (checkpoint.error !== null) {
      // Não tratar como "sem checkpoint": cair para a janela larga a cada
      // falha de leitura transformaria um erro transitório em varredura
      // pesada repetida, exatamente o padrão que a doc chama de custoso.
      return {
        status: "failed",
        retryable: true,
        reason: `falha ao ler checkpoint de claims: ${checkpoint.error.message}`,
      };
    }

    const fallback = new Date(now.getTime() - FALLBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const stored = checkpoint.data?.latest_record_at ?? null;
    const from =
      stored === null ? fallback : new Date(new Date(stored).getTime() - OVERLAP_MINUTES * 60 * 1000);

    const started = now;
    const tokenResult = await ensureAccessToken(deps, mlAccountId, now);

    if (!tokenResult.ok) {
      await recordSyncRunFailure(deps.db, {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        resource: "claims",
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
      result = await fetchSupportClaims({
        db: deps.db,
        organizationId,
        mlAccountId,
        sellerId,
        mercadoLivre: deps.mercadoLivre,
        accessToken: tokenResult.accessToken,
        updatedAfter: toMercadoLivreInstant(from),
        logger: context.logger,
      });
    } catch (error) {
      const finishedAt = deps.now?.() ?? new Date();
      const errorClass = error instanceof MercadoLivreApiError ? error.errorClass : "retryable";
      const reason =
        error instanceof Error ? error.message : "erro desconhecido ao reconciliar reclamações";

      await recordSyncRunFailure(deps.db, {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        resource: "claims",
        channel: "reconciliation",
        startedAt: started,
        finishedAt,
        reason,
        errorClass,
      }, context.logger);

      return { status: "failed", retryable: errorClass !== "not_retryable", reason };
    }

    const finishedAt = deps.now?.() ?? new Date();
    const partial = result.itemsFailed > 0 || result.truncated;
    const reasons: string[] = [];

    if (result.itemsFailed > 0) {
      reasons.push(`${String(result.itemsFailed)} reclamação(ões) falharam ao persistir`);
    }

    if (result.truncated) {
      reasons.push(`varredura truncada no teto de páginas (total remoto: ${String(result.remoteTotal)})`);
    }

    await recordSyncRunSuccess(deps.db, {
      organizationId,
      mlAccountId,
      jobId: envelope.jobId,
      resource: "claims",
      channel: "reconciliation",
      itemsProcessed: result.itemsProcessed,
      // **Só avança o checkpoint quando a varredura foi completa.** Avançar
      // após truncar pularia definitivamente os claims não alcançados —
      // mesma guarda conservadora que D-101 aplicou ao checkpoint de pedidos.
      latestRecordAt: partial ? from : new Date(result.latestRecordAt ?? from),
      startedAt: started,
      finishedAt,
      status: partial ? "partial" : "done",
      ...(partial ? { reason: reasons.join("; ") } : {}),
    }, context.logger);

    context.logger.info("sync_support_claims_reconcile_done", {
      ml_account_id: mlAccountId,
      items_processed: result.itemsProcessed,
      items_failed: result.itemsFailed,
      remote_total: result.remoteTotal,
      truncated: result.truncated,
      updated_after: toMercadoLivreInstant(from),
    });

    return { status: "done", processed: result.itemsProcessed };
  };
}
