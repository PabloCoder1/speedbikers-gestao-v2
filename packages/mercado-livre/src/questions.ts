import { z } from "zod";

import type { MercadoLivreClient } from "./http-client.js";

const mercadoLivreTimestampSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "data/hora inválida no payload de pergunta",
);

export const questionStatusSchema = z.enum([
  "ANSWERED",
  "BANNED",
  "CLOSED_UNANSWERED",
  "DELETED",
  "DISABLED",
  "UNANSWERED",
  "UNDER_REVIEW",
]);

export const questionAnswerStatusSchema = z.enum(["ACTIVE", "BANNED", "DISABLED"]);

const questionAnswerSchema = z.object({
  text: z.string().max(2_000),
  status: questionAnswerStatusSchema,
  date_created: mercadoLivreTimestampSchema,
});

/**
 * Contrato de `GET /questions/{id}?api_version=4` e de cada entrada de
 * `questions[]` nas buscas. Campos extras do detalhe (PII, `app_id`, etc.)
 * são deliberadamente ignorados: a primeira fatia persiste somente o que o
 * read model D-084/D-085 usa.
 *
 * Fonte oficial conferida em 2026-08-25:
 * developers.mercadolivre.com.br, "Perguntas e Respostas".
 */
export const receivedQuestionSchema = z
  .object({
    id: z.number().int().positive(),
    seller_id: z.number().int().positive(),
    buyer_id: z.number().int().positive().optional(),
    item_id: z.string().regex(/^MLB[0-9]+$/),
    status: questionStatusSchema,
    text: z.string().max(2_000),
    date_created: mercadoLivreTimestampSchema,
    last_updated: mercadoLivreTimestampSchema.optional(),
    deleted_from_listing: z.boolean().default(false),
    suspected_spam: z.boolean().default(false),
    hold: z.boolean().default(false),
    from: z
      .object({ id: z.number().int().positive() })
      .optional(),
    answer: questionAnswerSchema.nullable().default(null),
  })
  .refine((question) => question.buyer_id !== undefined || question.from !== undefined, {
    message: "pergunta sem buyer_id nem from.id",
  });

export const receivedQuestionsPageSchema = z.object({
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  questions: z.array(receivedQuestionSchema),
});

export type ReceivedQuestion = z.infer<typeof receivedQuestionSchema>;
export type ReceivedQuestionsPage = z.infer<typeof receivedQuestionsPageSchema>;

export type SupportQuestionBodyState =
  | "AVAILABLE"
  | "EMPTY"
  | "BANNED"
  | "MODERATED"
  | "UNAVAILABLE";

export interface SupportQuestionCaseProjection {
  channel: "QUESTION";
  externalCaseKey: string;
  externalCaseId: string;
  externalStatus: ReceivedQuestion["status"];
  customerExternalId: number;
  remoteUnreadCount: 0;
  remoteReplyState: "ALLOWED" | "BLOCKED";
  remoteReplyBlockReason: string | null;
  initialInternalStatus: "NOVO" | "RESOLVIDO";
  initialPriority: "NORMAL";
  lastActivityAt: string;
  lastInboundAt: string;
  lastOutboundAt: string | null;
  initialResolvedAt: string | null;
}

export interface SupportQuestionMessageProjection {
  externalMessageKey: string;
  externalMessageId: string | null;
  direction: "INBOUND" | "OUTBOUND";
  senderKind: "CUSTOMER" | "SELLER";
  remoteFromUserId: number;
  remoteToUserId: number;
  body: string | null;
  bodyState: SupportQuestionBodyState;
  remoteStatus: string;
  occurredAt: string;
  observedAt: string;
}

export interface SupportQuestionProjection {
  case: SupportQuestionCaseProjection;
  messages: SupportQuestionMessageProjection[];
  listingItemId: string;
}

export interface FetchReceivedQuestionOptions {
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
  questionId: number;
}

const RESOLVED_QUESTION_STATUSES = new Set<ReceivedQuestion["status"]>([
  "ANSWERED",
  "BANNED",
  "CLOSED_UNANSWERED",
  "DELETED",
  "DISABLED",
]);

function maxTimestamp(values: string[]): string {
  const latest = Math.max(...values.map((value) => Date.parse(value)));
  return new Date(latest).toISOString();
}

function questionBodyState(question: ReceivedQuestion): SupportQuestionBodyState {
  if (question.status === "BANNED") {
    return "BANNED";
  }

  if (question.status === "UNDER_REVIEW") {
    return "MODERATED";
  }

  if ((question.status === "DELETED" || question.status === "DISABLED") && question.text === "") {
    return "UNAVAILABLE";
  }

  return question.text === "" ? "EMPTY" : "AVAILABLE";
}

function answerBodyState(answer: NonNullable<ReceivedQuestion["answer"]>): SupportQuestionBodyState {
  if (answer.status === "BANNED") {
    return "BANNED";
  }

  if (answer.status === "DISABLED") {
    return "UNAVAILABLE";
  }

  return answer.text === "" ? "EMPTY" : "AVAILABLE";
}

function replyAvailability(question: ReceivedQuestion): {
  state: "ALLOWED" | "BLOCKED";
  reason: string | null;
} {
  if (question.deleted_from_listing) {
    return { state: "BLOCKED", reason: "DELETED_FROM_LISTING" };
  }

  if (question.hold) {
    return { state: "BLOCKED", reason: "QUESTION_ON_HOLD" };
  }

  if (question.suspected_spam) {
    return { state: "BLOCKED", reason: "SUSPECTED_SPAM" };
  }

  if (question.status !== "UNANSWERED") {
    return { state: "BLOCKED", reason: `STATUS_${question.status}` };
  }

  return { state: "ALLOWED", reason: null };
}

/**
 * Transforma uma pergunta já validada no read model de `support`, sem banco,
 * relógio oculto ou rede. `observedAt` é injetado para manter o mapper puro e
 * o teste determinístico.
 */
export function mapQuestionToSupportProjection(
  question: ReceivedQuestion,
  observedAt: Date,
): SupportQuestionProjection {
  const questionId = String(question.id);
  const buyerId = question.buyer_id ?? question.from?.id;

  if (buyerId === undefined) {
    // O schema já impede este estado; a guarda mantém a função segura para
    // chamadores TypeScript que construam o objeto sem executar `.parse()`.
    throw new Error(`pergunta ${questionId} sem comprador identificável`);
  }

  const answer = question.answer;
  const activityTimestamps = [
    question.date_created,
    ...(question.last_updated === undefined ? [] : [question.last_updated]),
    ...(answer === null ? [] : [answer.date_created]),
  ];
  const lastActivityAt = maxTimestamp(activityTimestamps);
  const isInitiallyResolved = answer !== null || RESOLVED_QUESTION_STATUSES.has(question.status);
  const availability = replyAvailability(question);
  const observedAtIso = observedAt.toISOString();

  const messages: SupportQuestionMessageProjection[] = [
    {
      externalMessageKey: `question:${questionId}:question`,
      externalMessageId: questionId,
      direction: "INBOUND",
      senderKind: "CUSTOMER",
      remoteFromUserId: buyerId,
      remoteToUserId: question.seller_id,
      body: question.text === "" ? null : question.text,
      bodyState: questionBodyState(question),
      remoteStatus: question.status,
      occurredAt: new Date(question.date_created).toISOString(),
      observedAt: observedAtIso,
    },
  ];

  if (answer !== null) {
    messages.push({
      externalMessageKey: `question:${questionId}:answer`,
      externalMessageId: null,
      direction: "OUTBOUND",
      senderKind: "SELLER",
      remoteFromUserId: question.seller_id,
      remoteToUserId: buyerId,
      body: answer.text === "" ? null : answer.text,
      bodyState: answerBodyState(answer),
      remoteStatus: answer.status,
      occurredAt: new Date(answer.date_created).toISOString(),
      observedAt: observedAtIso,
    });
  }

  return {
    case: {
      channel: "QUESTION",
      externalCaseKey: `question:${questionId}`,
      externalCaseId: questionId,
      externalStatus: question.status,
      customerExternalId: buyerId,
      // A API de perguntas expõe respondida/não respondida, não lido/não lido.
      // Não transformar uma coisa na outra.
      remoteUnreadCount: 0,
      remoteReplyState: availability.state,
      remoteReplyBlockReason: availability.reason,
      initialInternalStatus: isInitiallyResolved ? "RESOLVIDO" : "NOVO",
      initialPriority: "NORMAL",
      lastActivityAt,
      lastInboundAt: new Date(question.date_created).toISOString(),
      lastOutboundAt: answer === null ? null : new Date(answer.date_created).toISOString(),
      initialResolvedAt: isInitiallyResolved
        ? answer === null
          ? lastActivityAt
          : new Date(answer.date_created).toISOString()
        : null,
    },
    messages,
    listingItemId: question.item_id,
  };
}

/**
 * Adaptador de detalhe v4 de uma Pergunta. O cliente comum continua dono de
 * Authorization, retry/backoff e classificação HTTP; este adaptador fixa o
 * endpoint/query e impede que uma resposta chegue ao worker sem passar pelo
 * contrato oficial de `receivedQuestionSchema`.
 */
export function fetchReceivedQuestion(
  options: FetchReceivedQuestionOptions,
): Promise<ReceivedQuestion> {
  return options.mercadoLivre.request({
    method: "GET",
    path: `/questions/${String(options.questionId)}`,
    searchParams: { api_version: 4 },
    accessToken: options.accessToken,
    schema: receivedQuestionSchema,
  });
}

export interface FetchReceivedQuestionsPageOptions {
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
  /**
   * Filtro `status`. É um dos `available_filters` que a própria resposta
   * oficial declara, com exatamente os sete valores de `questionStatusSchema`
   * — não é parâmetro inventado.
   *
   * Obrigatório: uma busca sem filtro varre o histórico inteiro da conta
   * (medido em 2026-08-26 pela sonda de D-091 — entre 3.073 e 4.777 perguntas
   * por conta). Nenhum chamador da ingestão deve conseguir pedir isso sem
   * querer.
   */
  status: z.infer<typeof questionStatusSchema>;
  offset: number;
  limit: number;
}

/**
 * Adaptador de busca das Perguntas recebidas pela conta autenticada
 * (reconciliação, D-089). O `questions[]` da resposta carrega o MESMO objeto
 * que `GET /questions/{id}` devolve, então `receivedQuestionSchema` vale para
 * as duas — foi para isso que D-086 o escreveu como "contrato do detalhe e de
 * cada entrada de `questions[]` nas buscas".
 *
 * **Confirmado por leitura oficial em 2026-08-25** (`developers.mercadolivre.com.br`,
 * "Perguntas e Respostas", última atualização 05/06/2025 —
 * `docs/MERCADO_LIVRE.md` secao 2.12):
 *
 * - `available_filters` deste endpoint são `item`, `from`, `totalDivisions`,
 *   `division` e `status`. **Não existe filtro por data** — por isso a
 *   reconciliação não consegue ser "janela dos últimos N dias" e precisa se
 *   apoiar no `status`.
 * - `available_sorts` são `item_id`, `from_id`, `date_created` e `seller_id`,
 *   mas a resposta padrão traz `"sorts": []`: **a ordenação default não é
 *   documentada**. Nenhuma decisão desta reconciliação pode depender da ordem
 *   das páginas — daí varrer o conjunto inteiro do status escolhido, em vez
 *   de "as N mais recentes".
 * - A resposta traz `total`, `limit` e `questions[]` no topo; `offset` vive
 *   dentro de `filters`, não no topo. `receivedQuestionsPageSchema` reflete
 *   isso e ignora o resto.
 * - `search_type=scan` NÃO aparece documentado para este endpoint (só para
 *   `/questions/search`) e continua não presumido.
 */
export function fetchReceivedQuestionsPage(
  options: FetchReceivedQuestionsPageOptions,
): Promise<ReceivedQuestionsPage> {
  return options.mercadoLivre.request({
    method: "GET",
    path: "/my/received_questions/search",
    searchParams: {
      api_version: 4,
      status: options.status,
      offset: options.offset,
      limit: options.limit,
    },
    accessToken: options.accessToken,
    schema: receivedQuestionsPageSchema,
  });
}
