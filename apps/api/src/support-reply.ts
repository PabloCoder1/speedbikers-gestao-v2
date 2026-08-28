import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";
import { z } from "zod";

import type { Caller } from "./auth.js";
import type { Enqueuer } from "./enqueue.js";

/**
 * Confirmação humana de resposta a uma Pergunta (Fase 7B, D-096).
 *
 * **A `api` autoriza e registra; o `worker` envia.** Não é atalho: é o mesmo
 * desenho de todo comando privilegiado deste projeto — `/v1/nfe-imports/:id/apply`
 * e `/v1/erp-imports/:id/apply` também validam e enfileiram. E
 * `docs/ARCHITECTURE.md` secao 5 é explícito: a `api` nunca faz trabalho longo
 * inline. Um envio são DUAS chamadas ao Mercado Livre (revalidar e postar),
 * que é exatamente o que a regra cobre.
 *
 * O que fica aqui, e por quê:
 *
 * - **autorização** — papel e organização, refeitos no servidor;
 * - **a linha PENDING de `support_reply_attempts`** — gravada ANTES de
 *   enfileirar. Se a fila engolir a task ou o worker morrer, sobra um registro
 *   dizendo "não sabemos se saiu", que é a verdade, em vez de silêncio;
 * - **idempotência por `clientRequestId`** — a segunda chamada com a mesma
 *   chave nunca vira uma segunda resposta ao comprador.
 */

export interface SupportReplyDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export const supportReplyRequestSchema = z.object({
  /**
   * Gerado pelo NAVEGADOR na confirmação humana. Não pode ser gerado aqui: um
   * id novo a cada request não deduplicaria nada, e a garantia inteira contra
   * resposta duplicada mora nesta chave.
   */
  clientRequestId: z.string().min(1).max(120),
  text: z.string().trim().min(1).max(2_000),
  /** Texto sugerido pela IA, quando houver (Copiloto, fase posterior). */
  suggestedText: z.string().min(1).max(2_000).optional(),
});

export type SupportReplyRequest = z.infer<typeof supportReplyRequestSchema>;

export type SupportReplyOutcome =
  | { status: "queued"; attemptId: string }
  | { status: "already_sent"; attemptId: string }
  | { status: "in_flight"; attemptId: string }
  | { status: "previously_failed"; attemptId: string; reason: string }
  | { status: "invalid"; reason: string }
  | { status: "not_found" }
  | { status: "error"; reason: string };

interface CaseRow {
  id: string;
  organization_id: string;
  ml_account_id: string;
  channel: string;
  external_case_id: string;
  ml_accounts: { slug: string } | null;
}

export async function requestSupportReply(
  deps: SupportReplyDeps,
  caller: Caller,
  caseId: string,
  request: SupportReplyRequest,
): Promise<SupportReplyOutcome> {
  const now = deps.now?.() ?? new Date();

  const caseResult = await deps.db
    .from("support_cases")
    .select("id, organization_id, ml_account_id, channel, external_case_id, ml_accounts(slug)")
    .eq("id", caseId)
    .maybeSingle();

  if (caseResult.error !== null) {
    return { status: "error", reason: caseResult.error.message };
  }

  const supportCase = caseResult.data as unknown as CaseRow | null;

  // O `AdminClient` bypassa RLS, então a fronteira de organização é conferida
  // em código (`docs/ARCHITECTURE.md` secao 5). Case de outra organização é
  // "não encontrado", nunca "sem permissão" — a segunda resposta revelaria
  // que ele existe.
  if (supportCase?.organization_id !== caller.organizationId) {
    return { status: "not_found" };
  }

  // Organização e papel NÃO bastam: atendimento é escopado por CONTA. A
  // policy de leitura (`support_cases_select_permitted`) e a RPC de triagem
  // (`triage_support_case`, D-094) exigem `has_account_access`; só o envio —
  // a única escrita real no Mercado Livre — não exigia. Sem isto, um
  // GESTOR/OPERADOR sem permissão na conta responde ao comprador dela por
  // chamada direta à API, sendo que a RLS o impede até de LER o case.
  //
  // A checagem vem em código, não pela RPC: `private.has_account_access`
  // resolve `auth.uid()`, que é NULL sob `service_role` — chamá-la pelo
  // `AdminClient` devolveria `false` sempre. Espelha a função: ADMIN alcança
  // toda conta da própria organização, já confirmada acima.
  if (caller.role !== "ADMIN") {
    const permission = await deps.db
      .from("user_account_permissions")
      .select("user_id")
      .eq("user_id", caller.userId)
      .eq("ml_account_id", supportCase.ml_account_id)
      .maybeSingle();

    if (permission.error !== null) {
      return { status: "error", reason: permission.error.message };
    }

    // Mesmo silêncio da fronteira de organização: "não encontrado", nunca
    // "sem permissão" — a segunda resposta confirmaria que o case existe.
    if (permission.data === null) {
      return { status: "not_found" };
    }
  }

  if (supportCase.channel !== "QUESTION") {
    return {
      status: "invalid",
      reason: "só Perguntas podem ser respondidas hoje — mensagens e reclamações não estão integradas",
    };
  }

  const questionId = Number(supportCase.external_case_id);

  if (!Number.isSafeInteger(questionId)) {
    return { status: "invalid", reason: "identificador remoto da pergunta inválido" };
  }

  const slug = supportCase.ml_accounts?.slug;

  if (slug === undefined) {
    return { status: "error", reason: "conta sem slug para resolver a fila" };
  }

  // Idempotência antes de qualquer coisa: uma segunda confirmação com a mesma
  // chave nunca chega ao worker, logo nunca chega ao Mercado Livre.
  const existing = await deps.db
    .from("support_reply_attempts")
    .select("id, status, error_message")
    .eq("organization_id", caller.organizationId)
    .eq("client_request_id", request.clientRequestId)
    .maybeSingle();

  if (existing.error !== null) {
    return { status: "error", reason: existing.error.message };
  }

  if (existing.data !== null) {
    if (existing.data.status === "SUCCEEDED") {
      return { status: "already_sent", attemptId: existing.data.id };
    }

    if (existing.data.status === "PENDING") {
      return { status: "in_flight", attemptId: existing.data.id };
    }

    return {
      status: "previously_failed",
      attemptId: existing.data.id,
      reason: existing.data.error_message ?? "tentativa anterior falhou",
    };
  }

  const attempt = await deps.db
    .from("support_reply_attempts")
    .insert({
      organization_id: supportCase.organization_id,
      ml_account_id: supportCase.ml_account_id,
      support_case_id: supportCase.id,
      client_request_id: request.clientRequestId,
      requested_by: caller.userId,
      final_text: request.text,
      suggested_text: request.suggestedText ?? null,
      status: "PENDING",
      requested_at: now.toISOString(),
    })
    .select("id")
    .single();

  if (attempt.error !== null) {
    // 23505 é corrida com outra requisição do MESMO `clientRequestId`: a outra
    // ganhou, e enfileirar aqui produziria a segunda resposta que a chave
    // existe para impedir.
    if (attempt.error.code === "23505") {
      return { status: "in_flight", attemptId: "" };
    }

    return { status: "error", reason: attempt.error.message };
  }

  const attemptId = attempt.data.id;

  const enqueued = await deps.enqueuer.enqueue({
    jobType: "support.reply.send",
    organizationId: supportCase.organization_id,
    // A chave do envio é a chave da task: mesmo com retry de rede do
    // navegador, o Cloud Tasks colapsa em uma execução só.
    dedupeKey: `support-reply:${request.clientRequestId}`,
    // Fila da conta: o envio fala com o Mercado Livre e disputa o mesmo rate
    // limit das sincronizações daquela conta (D-036).
    queue: `ml-sync-${slug}`,
    payload: { attemptId },
  });

  deps.logger.info("support_reply_queued", {
    attempt_id: attemptId,
    support_case_id: supportCase.id,
    question_id: questionId,
    // O TEXTO da resposta nunca entra no log — é conteúdo de atendimento.
    deduplicated: enqueued.deduplicated,
  });

  return { status: "queued", attemptId };
}
