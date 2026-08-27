import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import {
  fetchPackMessages,
  fetchUnreadConversations,
  inferConversationKind,
  mapPackMessagesToSupportProjection,
  MercadoLivreApiError,
  parseConversationResource,
} from "@sb/mercado-livre";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { ensureAccessToken } from "./ml-token.js";
import { persistSupportConversation } from "./persist-support-conversation.js";
import { recordSyncRunFailure, recordSyncRunSuccess } from "./sync-runs.js";

/**
 * `sync.support.messages.reconcile` — varredura das conversas com mensagem não
 * lida de uma conta, pela mesma porta idempotente do job por conversa.
 *
 * A documentação oficial recomenda `/messages/unread` como redundância para
 * notificações perdidas. Aqui ele é mais que redundância: enquanto o painel do
 * Mercado Livre não estiver configurado, nenhum webhook chega (D-091) e esta é
 * a ÚNICA porta por onde uma mensagem entra.
 *
 * **O recorte é "não lidas", e o motivo é a API.** Não existe endpoint que
 * liste todas as conversas de uma conta, nem filtro por data — só o que está
 * pendente de leitura. Consequência aceita conscientemente: uma conversa que
 * alguém já leu pelo app do Mercado Livre não é trazida por esta varredura.
 * Ela chega pelo webhook quando houver mensagem nova. Fingir cobertura total
 * aqui seria mentir sobre o que a integração faz.
 */

const payloadSchema = z.object({ mlAccountId: z.uuid() });

export interface SyncSupportMessagesReconcileDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
}

/**
 * Teto de conversas por execução. A documentação registra até 500 conversas
 * por chamada de `/messages/unread`, e cada uma custa ao menos um GET dentro
 * do pool compartilhado de 500 rpm da mensageria. Sem teto, uma conta com
 * backlog grande consumiria a cota inteira e derrubaria os outros syncs.
 */
const MAX_CONVERSATIONS = 120;

export function createSyncSupportMessagesReconcileHandler(
  deps: SyncSupportMessagesReconcileDeps,
): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem mlAccountId" };
    }

    const { mlAccountId } = parsed.data;
    const started = deps.now?.() ?? new Date();

    const account = await deps.db
      .from("ml_accounts")
      .select("id, organization_id, seller_id, status")
      .eq("id", mlAccountId)
      .maybeSingle();

    if (account.error !== null || account.data === null) {
      context.logger.warn("sync_support_messages_reconcile_account_missing", {
        ml_account_id: mlAccountId,
      });

      return { status: "done", processed: 0 };
    }

    if (account.data.organization_id !== envelope.organizationId) {
      return {
        status: "failed",
        retryable: false,
        reason: "mlAccountId não pertence à organizationId do job",
      };
    }

    if (account.data.status !== "CONNECTED" || account.data.seller_id === null) {
      context.logger.info("sync_support_messages_reconcile_account_not_connected", {
        ml_account_id: mlAccountId,
      });

      return { status: "done", processed: 0 };
    }

    const organizationId = account.data.organization_id;
    const sellerId = account.data.seller_id;
    const tokenResult = await ensureAccessToken(deps, mlAccountId, started);

    if (!tokenResult.ok) {
      await recordSyncRunFailure(
        deps.db,
        {
          organizationId,
          mlAccountId,
          jobId: envelope.jobId,
          resource: "messages",
          channel: "reconciliation",
          startedAt: started,
          finishedAt: deps.now?.() ?? new Date(),
          reason: tokenResult.reason,
          errorClass: tokenResult.retryable ? "retryable" : "not_retryable",
        },
        context.logger,
      );

      return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
    }

    let unread;

    try {
      unread = await fetchUnreadConversations({
        mercadoLivre: deps.mercadoLivre,
        accessToken: tokenResult.accessToken,
      });
    } catch (error) {
      const errorClass = error instanceof MercadoLivreApiError ? error.errorClass : "retryable";
      const reason =
        error instanceof Error ? error.message : "erro desconhecido ao listar conversas não lidas";

      await recordSyncRunFailure(
        deps.db,
        {
          organizationId,
          mlAccountId,
          jobId: envelope.jobId,
          resource: "messages",
          channel: "reconciliation",
          startedAt: started,
          finishedAt: deps.now?.() ?? new Date(),
          reason,
          errorClass,
        },
        context.logger,
      );

      return { status: "failed", retryable: errorClass !== "not_retryable", reason };
    }

    const truncated = unread.results.length > MAX_CONVERSATIONS;
    const selected = unread.results.slice(0, MAX_CONVERSATIONS);

    let itemsProcessed = 0;
    let itemsFailed = 0;
    let itemsUnreadable = 0;
    let itemsRejected = 0;

    for (const entry of selected) {
      const resource = parseConversationResource(entry.resource);

      if (resource === null) {
        itemsUnreadable += 1;
        context.logger.warn("sync_support_messages_reconcile_resource_unreadable", {
          ml_account_id: mlAccountId,
        });
        continue;
      }

      // A conta só pode ingerir o que é dela. `/messages/unread` responde pela
      // conta autenticada, mas conferir aqui custa nada e fecha a porta para um
      // recurso de outro vendedor entrar pelo mesmo caminho.
      if (resource.sellerId !== sellerId) {
        itemsRejected += 1;
        continue;
      }

      // Falha por conversa NÃO derruba a varredura: uma conversa bloqueada ou
      // com payload estranho não pode custar as outras 119.
      try {
        const page = await fetchPackMessages({
          mercadoLivre: deps.mercadoLivre,
          accessToken: tokenResult.accessToken,
          packOrOrderId: resource.packOrOrderId,
          sellerId,
          offset: 0,
          limit: 100,
        });

        await persistSupportConversation(
          deps.db,
          { organizationId, mlAccountId },
          mapPackMessagesToSupportProjection(
            {
              kind: inferConversationKind(page) ?? "PACK",
              id: resource.packOrOrderId,
              sellerId,
            },
            page,
            deps.now?.() ?? new Date(),
            entry.count,
          ),
        );

        itemsProcessed += 1;
      } catch (error) {
        itemsFailed += 1;
        context.logger.warn("sync_support_messages_reconcile_item_failed", {
          ml_account_id: mlAccountId,
          conversation_id: resource.packOrOrderId,
          reason: error instanceof Error ? error.message : "erro desconhecido",
        });
      }
    }

    const finishedAt = deps.now?.() ?? new Date();
    const partial = itemsFailed > 0 || itemsUnreadable > 0 || itemsRejected > 0 || truncated;
    const reasons: string[] = [];

    if (itemsFailed > 0) {
      reasons.push(`${String(itemsFailed)} conversa(s) falharam ao sincronizar`);
    }

    if (itemsUnreadable > 0) {
      reasons.push(`${String(itemsUnreadable)} resource(s) fora do formato esperado`);
    }

    if (itemsRejected > 0) {
      reasons.push(`${String(itemsRejected)} conversa(s) recusadas por seller_id divergente`);
    }

    if (truncated) {
      reasons.push(
        `varredura truncada no teto de ${String(MAX_CONVERSATIONS)} conversas (não lidas: ${String(unread.results.length)})`,
      );
    }

    await recordSyncRunSuccess(
      deps.db,
      {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        resource: "messages",
        channel: "reconciliation",
        itemsProcessed,
        latestRecordAt: finishedAt,
        startedAt: started,
        finishedAt,
        status: partial ? "partial" : "done",
        ...(partial ? { reason: reasons.join("; ") } : {}),
      },
      context.logger,
    );

    context.logger.info("sync_support_messages_reconcile_done", {
      ml_account_id: mlAccountId,
      items_processed: itemsProcessed,
      items_failed: itemsFailed,
      items_unreadable: itemsUnreadable,
      items_rejected: itemsRejected,
      unread_total: unread.results.length,
      truncated,
    });

    return { status: "done", processed: itemsProcessed };
  };
}
