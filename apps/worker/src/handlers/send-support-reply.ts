import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import {
  fetchReceivedQuestion,
  mapQuestionToSupportProjection,
  MercadoLivreApiError,
  postQuestionAnswer,
} from "@sb/mercado-livre";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { ensureAccessToken } from "./ml-token.js";
import { persistSupportQuestion } from "./persist-support-question.js";

/**
 * `support.reply.send` — **o primeiro job do projeto que ESCREVE no Mercado
 * Livre** (D-096). Tudo até aqui era leitura.
 *
 * A `api` já autorizou a pessoa e gravou a linha PENDING de
 * `support_reply_attempts`; aqui acontece o envio de verdade.
 *
 * **Este handler é deliberadamente NÃO retryable depois do ponto de não
 * retorno.** É a diferença que importa em relação a todo outro job do
 * projeto: um 5xx numa sincronização significa "tente de novo"; um 5xx num
 * `POST /answers` pode significar que a resposta CHEGOU ao comprador.
 * Repetir produziria duas respostas. Falhas antes do POST (token,
 * revalidação) continuam retryable, porque nada saiu ainda.
 */

const payloadSchema = z.object({ attemptId: z.uuid() });

export interface SendSupportReplyDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
}

interface AttemptRow {
  id: string;
  organization_id: string;
  ml_account_id: string;
  support_case_id: string;
  final_text: string;
  status: string;
  support_cases: { external_case_id: string; channel: string } | null;
}

export function createSendSupportReplyHandler(deps: SendSupportReplyDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem attemptId" };
    }

    const { attemptId } = parsed.data;
    const now = deps.now?.() ?? new Date();

    const attemptResult = await deps.db
      .from("support_reply_attempts")
      .select(
        "id, organization_id, ml_account_id, support_case_id, final_text, status, support_cases(external_case_id, channel)",
      )
      .eq("id", attemptId)
      .maybeSingle();

    if (attemptResult.error !== null) {
      return { status: "failed", retryable: true, reason: attemptResult.error.message };
    }

    const attempt = attemptResult.data as unknown as AttemptRow | null;

    if (attempt === null) {
      return { status: "failed", retryable: false, reason: `tentativa ${attemptId} não encontrada` };
    }

    // Já resolvida: uma reentrega do Cloud Tasks NÃO pode reenviar. A linha
    // terminal é o registro de que isto já aconteceu uma vez.
    if (attempt.status !== "PENDING") {
      context.logger.info("support_reply_already_resolved", {
        attempt_id: attemptId,
        status: attempt.status,
      });

      return { status: "done", processed: 0 };
    }

    if (attempt.organization_id !== envelope.organizationId) {
      return { status: "failed", retryable: false, reason: "tentativa de outra organização" };
    }

    const questionId = Number(attempt.support_cases?.external_case_id);

    if (attempt.support_cases?.channel !== "QUESTION" || !Number.isSafeInteger(questionId)) {
      await resolveFailed(deps, attemptId, "escopo", "atendimento não é uma Pergunta respondível", now);

      return { status: "failed", retryable: false, reason: "atendimento não é uma Pergunta" };
    }

    const token = await ensureAccessToken(deps, attempt.ml_account_id, now);

    if (!token.ok) {
      // Antes do POST: nada saiu. Retryable transitório NÃO resolve a
      // tentativa — ela segue PENDING e a próxima entrega tenta de novo.
      if (token.retryable) {
        return { status: "failed", retryable: true, reason: token.reason };
      }

      await resolveFailed(deps, attemptId, "token", token.reason, deps.now?.() ?? new Date());

      return { status: "failed", retryable: false, reason: token.reason };
    }

    // Revalidação NA HORA (D-084/D-096): `support_cases.remote_reply_state` é
    // dica calculada na última sincronização (D-086, decisão 3). Entre ela e
    // agora a pergunta pode ter sido respondida por outra pessoa, deletada ou
    // retida. Responder por cima disso é o erro que esta chamada evita.
    let remote;

    try {
      remote = await fetchReceivedQuestion({
        mercadoLivre: deps.mercadoLivre,
        accessToken: token.accessToken,
        questionId,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "erro ao revalidar a pergunta";
      const retryable =
        !(error instanceof MercadoLivreApiError) || error.errorClass !== "not_retryable";

      if (retryable) {
        return { status: "failed", retryable: true, reason };
      }

      await resolveFailed(deps, attemptId, "revalidacao", reason, deps.now?.() ?? new Date());

      return { status: "failed", retryable: false, reason };
    }

    if (remote.status !== "UNANSWERED" || remote.deleted_from_listing || remote.hold) {
      const reason =
        remote.status === "UNANSWERED"
          ? "a pergunta está retida ou foi removida do anúncio no Mercado Livre"
          : `a pergunta não está mais aberta no Mercado Livre (${remote.status})`;

      await resolveFailed(deps, attemptId, "estado_remoto", reason, deps.now?.() ?? new Date());

      // Definitivo: repetir não vai reabrir a pergunta.
      return { status: "failed", retryable: false, reason };
    }

    // ---- Ponto de não retorno: daqui para baixo, nada é retryable. ----

    try {
      const answer = await postQuestionAnswer({
        mercadoLivre: deps.mercadoLivre,
        accessToken: token.accessToken,
        questionId,
        text: attempt.final_text,
      });

      await resolveSucceeded(deps, attemptId, String(answer.id), deps.now?.() ?? new Date());

      context.logger.info("support_reply_sent", {
        attempt_id: attemptId,
        question_id: questionId,
        // O TEXTO enviado nunca entra no log — é conteúdo de atendimento.
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "erro ao enviar a resposta";

      await resolveFailed(deps, attemptId, "envio", reason, deps.now?.() ?? new Date());

      // `retryable: false` mesmo em 5xx, de propósito: um 5xx aqui pode
      // significar que a resposta chegou. Uma nova tentativa exige nova
      // confirmação humana, com `clientRequestId` novo, e quem confirma vê
      // antes que a anterior falhou.
      return { status: "failed", retryable: false, reason };
    }

    // Materializar a mensagem outbound relendo do Mercado Livre, em vez de
    // escrever o que ACHAMOS que mandamos: o transcript passa a refletir o
    // que o Mercado Livre registrou de fato. Reaproveita o mapper e a
    // persistência idempotente de D-086, sem duplicar projeção.
    //
    // Falha aqui NÃO desfaz o envio nem falha o job: a resposta saiu e a
    // tentativa está registrada como SUCCEEDED. A próxima reconciliação
    // (a cada 10 minutos, D-092) traz a mensagem.
    try {
      const answered = await fetchReceivedQuestion({
        mercadoLivre: deps.mercadoLivre,
        accessToken: token.accessToken,
        questionId,
      });

      await persistSupportQuestion(
        deps.db,
        { organizationId: attempt.organization_id, mlAccountId: attempt.ml_account_id },
        mapQuestionToSupportProjection(answered, deps.now?.() ?? new Date()),
      );
    } catch (error) {
      context.logger.warn("support_reply_resync_failed", {
        attempt_id: attemptId,
        question_id: questionId,
        reason: error instanceof Error ? error.message : "erro desconhecido",
      });
    }

    return { status: "done", processed: 1 };
  };
}

async function resolveSucceeded(
  deps: SendSupportReplyDeps,
  attemptId: string,
  remoteMessageId: string,
  at: Date,
): Promise<void> {
  await deps.db
    .from("support_reply_attempts")
    .update({
      status: "SUCCEEDED",
      remote_message_id: remoteMessageId,
      resolved_at: at.toISOString(),
    })
    .eq("id", attemptId);
}

async function resolveFailed(
  deps: SendSupportReplyDeps,
  attemptId: string,
  errorCode: string,
  errorMessage: string,
  at: Date,
): Promise<void> {
  await deps.db
    .from("support_reply_attempts")
    .update({
      status: "FAILED",
      error_code: errorCode,
      error_message: errorMessage.slice(0, 2_000),
      resolved_at: at.toISOString(),
    })
    .eq("id", attemptId);
}
