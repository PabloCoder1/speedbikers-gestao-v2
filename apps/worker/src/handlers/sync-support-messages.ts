import type { AdminClient } from "@sb/db";
import type {
  MercadoLivreClient,
  MercadoLivreOAuthConfig,
  PackMessage,
  PackMessagesPage,
  SupportConversationReference,
} from "@sb/mercado-livre";
import {
  fetchMessageDetail,
  fetchPackMessages,
  inferConversationKind,
  mapPackMessagesToSupportProjection,
  MercadoLivreApiError,
  toMessageConversationLocator,
} from "@sb/mercado-livre";
import { z, ZodError } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { ensureAccessToken } from "./ml-token.js";
import { persistSupportConversation } from "./persist-support-conversation.js";

/**
 * Ingestão de uma conversa pós-venda.
 *
 * **A unidade é a CONVERSA, nunca a mensagem solta.** O webhook do tópico
 * `messages` entrega o ID de uma mensagem, mas persistir só ela deixaria o
 * case sem `conversation_status` — que é de onde sai o estado de resposta — e
 * sem as mensagens anteriores. Por isso, quando chega `messageId`, o handler
 * primeiro descobre a qual pack/pedido ela pertence e só então lê a conversa.
 *
 * Os dois produtores (webhook e reconciliação) chegam aqui pelo mesmo
 * contrato, com o mesmo resultado — inclusive quando os dois chegam juntos: os
 * UPSERTs de `persistSupportConversation` convergem.
 */

const payloadSchema = z
  .object({
    mlAccountId: z.uuid(),
    packOrOrderId: z
      .string()
      .regex(/^[0-9]+$/)
      .optional(),
    kind: z.enum(["PACK", "ORDER"]).optional(),
    messageId: z.string().min(1).max(200).optional(),
    unreadCount: z.number().int().nonnegative().optional(),
  })
  .refine((payload) => payload.packOrOrderId !== undefined || payload.messageId !== undefined, {
    message: "payload precisa de packOrOrderId ou messageId",
  });

export interface SyncSupportMessagesDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
}

/**
 * Uma conversa longa não pode ficar pela metade nem varrer sem fim. O teto de
 * páginas é a mesma proteção de `ml-support-questions-fetch.ts` (D-089).
 */
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

function remoteFailure(error: unknown, subject: string): JobOutcome {
  if (error instanceof MercadoLivreApiError) {
    return {
      status: "failed",
      retryable: error.errorClass !== "not_retryable",
      reason: error.message,
    };
  }

  if (error instanceof ZodError) {
    return {
      status: "failed",
      retryable: false,
      reason: `${subject} fora do contrato esperado`,
    };
  }

  return {
    status: "failed",
    retryable: true,
    reason: error instanceof Error ? error.message : `erro desconhecido ao buscar ${subject}`,
  };
}

async function readWholeConversation(
  deps: SyncSupportMessagesDeps,
  accessToken: string,
  packOrOrderId: string,
  sellerId: number,
): Promise<PackMessagesPage> {
  const first = await fetchPackMessages({
    mercadoLivre: deps.mercadoLivre,
    accessToken,
    packOrOrderId,
    sellerId,
    offset: 0,
    limit: PAGE_LIMIT,
  });

  const total = first.paging?.total ?? first.messages.length;
  const messages: PackMessage[] = [...first.messages];

  for (let page = 1; page < MAX_PAGES && messages.length < total; page += 1) {
    const next = await fetchPackMessages({
      mercadoLivre: deps.mercadoLivre,
      accessToken,
      packOrOrderId,
      sellerId,
      offset: page * PAGE_LIMIT,
      limit: PAGE_LIMIT,
    });

    if (next.messages.length === 0) {
      break;
    }

    messages.push(...next.messages);
  }

  return { ...first, messages };
}

export function createSyncSupportMessagesHandler(deps: SyncSupportMessagesDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return {
        status: "failed",
        retryable: false,
        reason: "payload sem mlAccountId e sem packOrOrderId/messageId válidos",
      };
    }

    const { mlAccountId, messageId, unreadCount } = parsed.data;
    const account = await deps.db
      .from("ml_accounts")
      .select("organization_id, seller_id, status")
      .eq("id", mlAccountId)
      .maybeSingle();

    if (account.error !== null) {
      return {
        status: "failed",
        retryable: true,
        reason: `falha ao ler conta Mercado Livre: ${account.error.message}`,
      };
    }

    if (account.data === null) {
      context.logger.warn("sync_support_messages_account_missing", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    if (account.data.organization_id !== envelope.organizationId) {
      return {
        status: "failed",
        retryable: false,
        reason: "mlAccountId não pertence à organizationId do job",
      };
    }

    if (account.data.status !== "CONNECTED") {
      context.logger.info("sync_support_messages_account_not_connected", {
        ml_account_id: mlAccountId,
      });

      return { status: "done", processed: 0 };
    }

    if (account.data.seller_id === null) {
      return { status: "failed", retryable: false, reason: "conta CONNECTED sem seller_id" };
    }

    const sellerId = account.data.seller_id;
    const observedAt = deps.now?.() ?? new Date();
    const tokenResult = await ensureAccessToken(deps, mlAccountId, observedAt);

    if (!tokenResult.ok) {
      return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
    }

    let packOrOrderId = parsed.data.packOrOrderId ?? null;
    let kind = parsed.data.kind ?? null;

    if (packOrOrderId === null && messageId !== undefined) {
      let locator;

      try {
        locator = toMessageConversationLocator(
          await fetchMessageDetail({
            mercadoLivre: deps.mercadoLivre,
            accessToken: tokenResult.accessToken,
            messageId,
          }),
        );
      } catch (error) {
        return remoteFailure(error, "detalhe de mensagem");
      }

      if (locator.packOrOrderId === null) {
        // Sem pack/pedido não há conversa a ler. Falhar com retry só repetiria
        // a mesma leitura para sempre; registrar e encerrar é honesto.
        context.logger.warn("sync_support_messages_unlocatable", {
          ml_account_id: mlAccountId,
          message_id: messageId,
        });

        return { status: "done", processed: 0 };
      }

      packOrOrderId = locator.packOrOrderId;
      kind = locator.kind;
    }

    if (packOrOrderId === null) {
      return { status: "failed", retryable: false, reason: "conversa sem pack/pedido resolvido" };
    }

    let page: PackMessagesPage;

    try {
      page = await readWholeConversation(deps, tokenResult.accessToken, packOrOrderId, sellerId);
    } catch (error) {
      return remoteFailure(error, "conversa pós-venda");
    }

    // Ordem de preferência: o que o produtor já sabia, depois o que o próprio
    // payload remoto declara. O caminho da URL não serve — a documentação manda
    // usar o segmento `/packs` inclusive para pedido sem pack.
    const resolvedKind = kind ?? inferConversationKind(page) ?? "PACK";
    const reference: SupportConversationReference = {
      kind: resolvedKind,
      id: packOrOrderId,
      sellerId,
    };

    let result;

    try {
      result = await persistSupportConversation(
        deps.db,
        { organizationId: account.data.organization_id, mlAccountId },
        mapPackMessagesToSupportProjection(reference, page, observedAt, unreadCount ?? 0),
      );
    } catch (error) {
      return {
        status: "failed",
        retryable: true,
        reason: error instanceof Error ? error.message : "erro desconhecido ao persistir a conversa",
      };
    }

    // Nada de texto de mensagem no log — mesma regra de D-089 e D-096.
    context.logger.info("sync_support_messages_done", {
      ml_account_id: mlAccountId,
      conversation_kind: resolvedKind,
      conversation_id: packOrOrderId,
      messages: result.messagesUpserted,
      link_mode: result.linkMode,
    });

    return { status: "done", processed: result.messagesUpserted };
  };
}
