import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import {
  fetchReceivedQuestion,
  mapQuestionToSupportProjection,
  MercadoLivreApiError,
} from "@sb/mercado-livre";
import { z, ZodError } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { ensureAccessToken } from "./ml-token.js";
import { persistSupportQuestion } from "./persist-support-question.js";

/**
 * Primeira entrada de rede do domínio `support` (D-087): processa exatamente
 * um `questionId`. O produtor de webhook e a reconciliação por busca ainda não
 * existem; ambos poderão enfileirar este mesmo contrato depois.
 */

const payloadSchema = z.object({
  mlAccountId: z.uuid(),
  questionId: z.number().int().positive(),
});

export interface SyncSupportQuestionDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
}

function remoteFailure(error: unknown): JobOutcome {
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
      reason: "resposta de pergunta fora do contrato esperado",
    };
  }

  return {
    status: "failed",
    retryable: true,
    reason: error instanceof Error ? error.message : "erro desconhecido ao buscar a pergunta",
  };
}

export function createSyncSupportQuestionHandler(deps: SyncSupportQuestionDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return {
        status: "failed",
        retryable: false,
        reason: "payload sem mlAccountId/questionId válidos",
      };
    }

    const { mlAccountId, questionId } = parsed.data;
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
      context.logger.warn("sync_support_question_account_missing", {
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

    if (account.data.status !== "CONNECTED") {
      context.logger.info("sync_support_question_account_not_connected", {
        ml_account_id: mlAccountId,
      });

      return { status: "done", processed: 0 };
    }

    if (account.data.seller_id === null) {
      return {
        status: "failed",
        retryable: false,
        reason: "conta CONNECTED sem seller_id",
      };
    }

    const observedAt = deps.now?.() ?? new Date();
    const tokenResult = await ensureAccessToken(deps, mlAccountId, observedAt);

    if (!tokenResult.ok) {
      return {
        status: "failed",
        retryable: tokenResult.retryable,
        reason: tokenResult.reason,
      };
    }

    let question;

    try {
      question = await fetchReceivedQuestion({
        mercadoLivre: deps.mercadoLivre,
        accessToken: tokenResult.accessToken,
        questionId,
      });
    } catch (error) {
      return remoteFailure(error);
    }

    if (question.seller_id !== account.data.seller_id) {
      return {
        status: "failed",
        retryable: false,
        reason: "pergunta não pertence ao seller da conta",
      };
    }

    try {
      await persistSupportQuestion(
        deps.db,
        { organizationId: account.data.organization_id, mlAccountId },
        mapQuestionToSupportProjection(question, observedAt),
      );
    } catch (error) {
      return {
        status: "failed",
        retryable: true,
        reason: error instanceof Error ? error.message : "erro desconhecido ao persistir a pergunta",
      };
    }

    context.logger.info("sync_support_question_done", {
      ml_account_id: mlAccountId,
      question_id: String(questionId),
      external_status: question.status,
    });

    return { status: "done", processed: 1 };
  };
}
