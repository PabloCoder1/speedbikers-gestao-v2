import type { AdminClient, TablesUpdate } from "@sb/db";
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
 * `support.reply.send.v2` — continuação do envio de Perguntas ao Mercado
 * Livre (D-096).
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
 * A trava persistida antes do POST também cobre duas entregas simultâneas
 * e uma queda após a chamada, antes de gravar o resultado.
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
  dispatch_queue: string | null;
  dispatch_started_at: string | null;
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
        "id, organization_id, ml_account_id, support_case_id, final_text, status, dispatch_queue, dispatch_started_at, support_cases(external_case_id, channel)",
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

    if (attempt.organization_id !== envelope.organizationId) {
      return { status: "failed", retryable: false, reason: "tentativa de outra organização" };
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

    if (attempt.dispatch_started_at !== null) {
      context.logger.info("support_reply_dispatch_already_started", { attempt_id: attemptId });

      return { status: "done", processed: 0 };
    }

    if (attempt.dispatch_queue === null) {
      context.logger.warn("support_reply_legacy_outcome_unconfirmed", { attempt_id: attemptId });

      return { status: "failed", retryable: false, reason: "tentativa anterior à trava de envio exige conferência no Mercado Livre" };
    }

    const recordOutcome = async (
      patch: TablesUpdate<"support_reply_attempts">,
      dispatchStartedAt: string | null,
    ): Promise<boolean> => {
      try {
        const update = deps.db
          .from("support_reply_attempts")
          .update(patch)
          .eq("id", attemptId)
          .eq("status", "PENDING");
        const scoped = dispatchStartedAt === null
          ? update.is("dispatch_started_at", null)
          : update.eq("dispatch_started_at", dispatchStartedAt);
        const recorded = await scoped.select("id").maybeSingle();

        if (recorded.error === null && recorded.data !== null) {
          return true;
        }
      } catch {
        // Depois do POST, o desfecho remoto não pode virar erro retryable
        // por causa de uma falha de transporte ao gravar a auditoria.
      }

      context.logger.error("support_reply_outcome_unrecorded", {
        attempt_id: attemptId,
        status: patch.status,
      });

      return false;
    };

    const fail = async (code: string, reason: string, dispatchStartedAt: string | null = null): Promise<JobOutcome> => {
      const recorded = await recordOutcome({
        status: "FAILED",
        error_code: code,
        error_message: reason.slice(0, 2_000),
        resolved_at: (deps.now?.() ?? new Date()).toISOString(),
      }, dispatchStartedAt);

      return { status: "failed", retryable: !recorded && dispatchStartedAt === null, reason };
    };

    const questionId = Number(attempt.support_cases?.external_case_id);

    if (attempt.support_cases?.channel !== "QUESTION" || !Number.isSafeInteger(questionId)) {
      return fail("escopo", "atendimento não é uma Pergunta respondível");
    }

    const token = await ensureAccessToken(deps, attempt.ml_account_id, now);

    if (!token.ok) {
      // Antes do POST: nada saiu. Retryable transitório NÃO resolve a
      // tentativa — ela segue PENDING e a próxima entrega tenta de novo.
      if (token.retryable) {
        return { status: "failed", retryable: true, reason: token.reason };
      }

      return fail("token", token.reason);
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

      return fail("revalidacao", reason);
    }

    if (remote.status !== "UNANSWERED" || remote.deleted_from_listing || remote.hold) {
      const reason =
        remote.status === "UNANSWERED"
          ? "a pergunta está retida ou foi removida do anúncio no Mercado Livre"
          : `a pergunta não está mais aberta no Mercado Livre (${remote.status})`;

      return fail("estado_remoto", reason);
    }

    const dispatchStartedAt = (deps.now?.() ?? new Date()).toISOString();
    const claim = await deps.db
      .from("support_reply_attempts")
      .update({ dispatch_started_at: dispatchStartedAt })
      .eq("id", attemptId)
      .eq("status", "PENDING")
      .is("dispatch_started_at", null)
      .select("id")
      .maybeSingle();

    if (claim.error !== null) {
      return { status: "failed", retryable: true, reason: "não foi possível iniciar o envio da resposta" };
    }

    if (claim.data === null) {
      return { status: "done", processed: 0 };
    }

    // ---- Ponto de não retorno: daqui para baixo, nada é retryable. ----

    let remoteMessageId: string;
    try {
      const answer = await postQuestionAnswer({
        mercadoLivre: deps.mercadoLivre,
        accessToken: token.accessToken,
        questionId,
        text: attempt.final_text,
      });

      remoteMessageId = String(answer.id);
    } catch (error) {
      if (error instanceof MercadoLivreApiError && [400, 401, 403, 404, 422].includes(error.status)) {
        return fail("envio", `Mercado Livre recusou a resposta (HTTP ${String(error.status)})`, dispatchStartedAt);
      }

      // 5xx, timeout ou resposta inválida podem ocorrer após a entrega.
      // PENDING retém a trava por caso. A mensagem orienta quem vê a
      // tentativa na Central a conferir o desfecho no marketplace.
      const reason = "Envio não confirmado. Confira a resposta no Mercado Livre antes de reconciliar a tentativa.";
      await recordOutcome({ status: "PENDING", error_message: reason }, dispatchStartedAt);
      context.logger.warn("support_reply_dispatch_uncertain", {
        attempt_id: attemptId,
        question_id: questionId,
        remote_status: error instanceof MercadoLivreApiError ? error.status : undefined,
      });

      return { status: "failed", retryable: false, reason };
    }

    await recordOutcome({
      status: "SUCCEEDED",
      remote_message_id: remoteMessageId,
      resolved_at: (deps.now?.() ?? new Date()).toISOString(),
    }, dispatchStartedAt);
    context.logger.info("support_reply_sent", {
      attempt_id: attemptId,
      question_id: questionId,
      remote_message_id: remoteMessageId,
    });

    // Materializar a mensagem outbound relendo do Mercado Livre, em vez de
    // escrever o que ACHAMOS que mandamos: o transcript passa a refletir o
    // que o Mercado Livre registrou de fato. Reaproveita o mapper e a
    // persistência idempotente de D-086, sem duplicar projeção.
    //
    // Falha aqui não desfaz o envio. A próxima reconciliação (D-092)
    // pode materializar a mensagem a partir do estado remoto.
    try {
      const answered = await fetchReceivedQuestion({
        mercadoLivre: deps.mercadoLivre,
        accessToken: token.accessToken,
        questionId,
      });

      await persistSupportQuestion(
        deps.db,
        { organizationId: attempt.organization_id, mlAccountId: attempt.ml_account_id, source: "SYSTEM" },
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
