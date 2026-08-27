import { z } from "zod";

import type { MercadoLivreClient } from "./http-client.js";

/**
 * Contrato da mensageria pós-venda (`tag=post_sale`).
 *
 * Fonte oficial conferida ao vivo em 2026-08-26 em duas páginas de
 * `developers.mercadolivre.com.br`: "Gestão de mensagens pós-venda"
 * (atualizada em 27/04/2026) e "Mensagens pendentes" (30/12/2025).
 *
 * **As duas páginas discordam entre si sobre a MESMA resposta**, e é por isso
 * que praticamente todo campo aqui é permissivo:
 *
 * | campo             | "Gestão de mensagens"       | "Mensagens pendentes"        |
 * |-------------------|-----------------------------|------------------------------|
 * | `from.user_id`    | número `123456789000`       | string `"415458330"`         |
 * | `status`          | `"available"` (minúsculas)  | `"IN_MODERATION"` (maiúsc.)  |
 * | moderação/status  | `"clean"`                   | `"NON_MODERATED"`            |
 * | moderação/motivo  | `null`                      | `"none"`                     |
 * | moderação/origem  | `source`                    | `by`                         |
 * | `to`              | presente                    | **ausente**                  |
 * | `message_resources[].name` | `"sellers"`        | `"seller"`                   |
 *
 * A regra adotada: **estrito na ESTRUTURA, permissivo nos VALORES.** Um status
 * novo ou uma variação de caixa não pode derrubar a ingestão de uma conversa
 * inteira — normalizamos na comparação em vez de enumerar. O oposto (enum
 * fechado) transformaria uma mudança cosmética do Mercado Livre em perda de
 * atendimento.
 */

const messageTimestampSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "data/hora inválida no payload de mensagem");

const nullableTimestampSchema = messageTimestampSchema.nullable().default(null);

/**
 * `user_id` chega como número numa página e como string na outra. Aceitar as
 * duas formas e normalizar para número é o que impede a ingestão de quebrar
 * conforme o endpoint.
 */
const remoteUserIdSchema = z
  .union([z.number().int(), z.string().regex(/^[0-9]+$/)])
  .transform((value) => (typeof value === "number" ? value : Number(value)))
  .refine((value) => Number.isSafeInteger(value) && value > 0, "user_id fora da faixa segura");

/**
 * Só `user_id`. O payload real traz também `email` e `name` do comprador — o
 * `.parse()` do Zod descarta chaves não declaradas, então **PII do comprador
 * nunca entra no processo**. Isso é deliberado, não descuido: o read model de
 * D-084 guarda identificador remoto, não dados pessoais.
 */
const messagePartySchema = z.object({ user_id: remoteUserIdSchema });

const messageResourceRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export const packMessageSchema = z.object({
  id: z.string().min(1).max(200),
  site_id: z.string().min(1).nullable().default(null),
  from: messagePartySchema,
  // Ausente em um dos exemplos oficiais. Sem `to` ainda dá para classificar a
  // mensagem pelo remetente, que é o que direção e `sender_kind` precisam.
  to: messagePartySchema.nullable().default(null),
  status: z.string().nullable().default(null),
  text: z.string().nullable().default(null),
  message_date: z
    .object({
      received: nullableTimestampSchema,
      available: nullableTimestampSchema,
      notified: nullableTimestampSchema,
      created: nullableTimestampSchema,
      read: nullableTimestampSchema,
    })
    .nullable()
    .default(null),
  message_moderation: z
    .object({
      status: z.string().nullable().default(null),
      reason: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  // O conteúdo do anexo não é persistido nesta fatia; só a existência importa
  // para o transcript não mentir sobre uma mensagem "vazia" que era um arquivo.
  message_attachments: z.array(z.unknown()).nullable().default(null),
  message_resources: z.array(messageResourceRefSchema).default([]),
});

export const conversationStatusSchema = z.object({
  path: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  substatus: z.string().nullable().default(null),
  status_date: nullableTimestampSchema,
  status_update_allowed: z.boolean().nullable().default(null),
  claim_id: z.union([z.number().int(), z.string()]).nullable().default(null),
  shipping_id: z.union([z.number().int(), z.string()]).nullable().default(null),
});

export const packMessagesPageSchema = z.object({
  paging: z
    .object({
      limit: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .nullable()
    .default(null),
  conversation_status: conversationStatusSchema.nullable().default(null),
  messages: z.array(packMessageSchema).default([]),
  // `nonnegative`, não `positive` (D-103): o tráfego real do webhook trouxe
  // 0 — provável "vendedor não pode responder", mas o campo não alimenta
  // lógica nenhuma hoje, então só ACEITAR o valor observado é o correto
  // (D-097: contrato estrito na estrutura, permissivo nos valores; o
  // `.positive()` original era suposição sobre um campo não consumido).
  seller_max_message_length: z.number().int().nonnegative().nullable().default(null),
});

export const unreadConversationsSchema = z.object({
  user_id: remoteUserIdSchema,
  results: z
    .array(
      z.object({
        resource: z.string().min(1),
        count: z.number().int().nonnegative(),
      }),
    )
    .default([]),
});

export type PackMessage = z.infer<typeof packMessageSchema>;
export type PackMessagesPage = z.infer<typeof packMessagesPageSchema>;
export type UnreadConversations = z.infer<typeof unreadConversationsSchema>;

/**
 * IDs dos Agentes de Mensageria, um por site, publicados na tabela oficial de
 * "Nova arquitetura de mensageria" (vigente no MLB desde 02/02/2026).
 *
 * Desde então, ao LER uma conversa intermediada, `from.user_id` é o AGENTE e
 * não o comprador real. Tratar esse ID como cliente encheria a base de cases
 * apontando para o mesmo "comprador" — e é exatamente o que D-083 proíbe ao
 * dizer que identidade vem de conta + recurso remoto, nunca de `from`/`to`.
 */
export const MESSAGING_AGENT_USER_IDS: ReadonlySet<number> = new Set([
  3020819166, // MLC
  3037204123, // MCO
  3037204279, // MLM
  3037674934, // MLA
  3037675074, // MLB
  3037204685, // MLU
]);

export type SupportMessageBodyState =
  | "AVAILABLE"
  | "EMPTY"
  | "BANNED"
  | "MODERATED"
  | "UNAVAILABLE";

export type SupportSenderKind =
  | "CUSTOMER"
  | "SELLER"
  | "MERCADO_LIVRE_AGENT"
  | "MEDIATOR"
  | "SYSTEM"
  | "UNKNOWN";

/** Identifica a conversa. `PACK` e `ORDER` compartilham o mesmo endpoint. */
export interface SupportConversationReference {
  kind: "PACK" | "ORDER";
  /** Numérico, como exigido por `support_cases.external_case_id`. */
  id: string;
  sellerId: number;
}

export interface SupportConversationCaseProjection {
  channel: "POST_SALE_MESSAGE";
  externalCaseKey: string;
  externalCaseId: string;
  packId: number | null;
  externalStatus: string | null;
  externalSubstatus: string | null;
  customerExternalId: number | null;
  conversationPath: string | null;
  remoteUnreadCount: number;
  remoteReplyState: "UNKNOWN" | "ALLOWED" | "BLOCKED";
  remoteReplyBlockReason: string | null;
  initialInternalStatus: "NOVO";
  initialPriority: "NORMAL";
  lastActivityAt: string;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  initialResolvedAt: null;
}

export interface SupportConversationMessageProjection {
  externalMessageKey: string;
  externalMessageId: string;
  direction: "INBOUND" | "OUTBOUND";
  senderKind: SupportSenderKind;
  remoteFromUserId: number;
  remoteToUserId: number | null;
  body: string | null;
  bodyState: SupportMessageBodyState;
  remoteStatus: string | null;
  occurredAt: string;
  observedAt: string;
}

export interface SupportConversationProjection {
  case: SupportConversationCaseProjection;
  messages: SupportConversationMessageProjection[];
}

function normalize(value: string | null): string {
  return value === null ? "" : value.trim().toUpperCase();
}

export function classifySender(userId: number, sellerId: number): SupportSenderKind {
  if (userId === sellerId) {
    return "SELLER";
  }

  if (MESSAGING_AGENT_USER_IDS.has(userId)) {
    return "MERCADO_LIVRE_AGENT";
  }

  return "CUSTOMER";
}

/**
 * `body_state` rotula, não censura — mesma escolha de D-086 para Perguntas: o
 * texto continua gravado quando o Mercado Livre o entrega, e o estado diz em
 * que condição ele chegou. A moderação é conferida ANTES de "vazio" porque
 * "moderada e sem texto" é informação melhor do que "vazia".
 *
 * A documentação registra que mensagem moderada do COMPRADOR não aparece na
 * listagem, enquanto a do VENDEDOR aparece mesmo moderada. Ou seja: um estado
 * moderado aqui é quase sempre mensagem nossa — motivo a mais para preservá-lo
 * visível na tela em vez de sumir com ela.
 */
export function messageBodyState(message: PackMessage): SupportMessageBodyState {
  const status = normalize(message.status);
  const moderation = normalize(message.message_moderation?.status ?? null);

  if (status === "REJECTED" || moderation === "REJECTED") {
    return "MODERATED";
  }

  if (status === "MODERATED" || status === "IN_MODERATION" || moderation === "PENDING") {
    return "MODERATED";
  }

  if (message.text === null || message.text.trim() === "") {
    // Um anexo sem texto não é uma mensagem vazia: some da tela se for tratado
    // como tal. `UNAVAILABLE` diz "havia conteúdo que não é texto".
    return (message.message_attachments?.length ?? 0) > 0 ? "UNAVAILABLE" : "EMPTY";
  }

  return "AVAILABLE";
}

function messageOccurredAt(message: PackMessage, fallback: string): string {
  const candidates = [
    message.message_date?.created ?? null,
    message.message_date?.received ?? null,
    message.message_date?.available ?? null,
  ];
  const first = candidates.find((value): value is string => value !== null);

  return first === undefined ? fallback : new Date(first).toISOString();
}

/**
 * Estado de resposta a partir de `conversation_status`. Conservador por
 * desenho (D-086, decisão 3): só `active` libera, ausência vira `UNKNOWN`, e
 * qualquer outra coisa bloqueia com o motivo remoto preservado.
 *
 * A documentação lista várias formas de a conversa fechar — ordem cancelada,
 * mediação em curso, e as 48 horas úteis do fluxo com agente. Não há enum
 * oficial completo, então enumerar aqui seria inventar. O hint nunca substitui
 * a revalidação na hora de enviar, exatamente como em D-096.
 */
export function conversationReplyState(
  status: z.infer<typeof conversationStatusSchema> | null,
): { state: "UNKNOWN" | "ALLOWED" | "BLOCKED"; reason: string | null } {
  if (status?.status == null) {
    return { state: "UNKNOWN", reason: null };
  }

  if (normalize(status.status) === "ACTIVE") {
    return { state: "ALLOWED", reason: null };
  }

  const substatus = normalize(status.substatus);

  return {
    state: "BLOCKED",
    reason: substatus === "" ? normalize(status.status) : `${normalize(status.status)}:${substatus}`,
  };
}

/**
 * Descobre, pelo próprio payload remoto, se a conversa é de pack ou de pedido.
 *
 * O endpoint usa o segmento `/packs` nos dois casos — a documentação manda usar
 * o `order_id` ali quando `pack_id` é nulo —, então o caminho da URL NÃO
 * responde a pergunta. `message_resources[].name` responde, e vem do Mercado
 * Livre. Aceita `sellers` e `seller` porque as duas páginas oficiais divergem.
 */
export function inferConversationKind(page: PackMessagesPage): "PACK" | "ORDER" | null {
  for (const message of page.messages) {
    for (const resource of message.message_resources) {
      const name = resource.name.trim().toLowerCase();

      if (name === "packs" || name === "pack") {
        return "PACK";
      }

      if (name === "orders" || name === "order") {
        return "ORDER";
      }
    }
  }

  return null;
}

/**
 * Transforma uma conversa já validada no read model de `support`, sem banco,
 * relógio oculto ou rede — mesmo desenho puro de `mapQuestionToSupportProjection`.
 *
 * `unreadCount` entra por parâmetro porque a contagem de não lidas vive em
 * `/messages/unread`, não no payload da conversa. Quem sincroniza por webhook
 * não a conhece e passa 0.
 */
export function mapPackMessagesToSupportProjection(
  reference: SupportConversationReference,
  page: PackMessagesPage,
  observedAt: Date,
  unreadCount = 0,
): SupportConversationProjection {
  const observedAtIso = observedAt.toISOString();
  const keyPrefix = reference.kind === "PACK" ? "message:pack:" : "message:order:";
  const messages: SupportConversationMessageProjection[] = page.messages.map((message) => {
    const senderKind = classifySender(message.from.user_id, reference.sellerId);

    return {
      externalMessageKey: `message:${message.id}`,
      externalMessageId: message.id,
      direction: senderKind === "SELLER" ? "OUTBOUND" : "INBOUND",
      senderKind,
      remoteFromUserId: message.from.user_id,
      remoteToUserId: message.to?.user_id ?? null,
      body: message.text === null || message.text === "" ? null : message.text,
      bodyState: messageBodyState(message),
      remoteStatus: message.status,
      occurredAt: messageOccurredAt(message, observedAtIso),
      observedAt: observedAtIso,
    };
  });

  const inboundTimestamps = messages
    .filter((message) => message.direction === "INBOUND")
    .map((message) => Date.parse(message.occurredAt));
  const outboundTimestamps = messages
    .filter((message) => message.direction === "OUTBOUND")
    .map((message) => Date.parse(message.occurredAt));

  // `status_date` é FALLBACK, nunca entra num `max()` com as mensagens.
  //
  // Medido em produção em 2026-08-27, na primeira ingestão real: o
  // `status_date` das conversas voltava praticamente no instante da consulta.
  // Somado ao máximo, ele empurrava TODAS as conversas para o mesmo horário e
  // destruía a ordenação da Caixa de Entrada, que ordena por `last_activity_at
  // desc` — doze conversas com recências diferentes viravam doze empates no
  // segundo da sincronização.
  //
  // Atividade de uma conversa é mensagem. Sem nenhuma, `status_date` é a única
  // coisa conhecida; sem ele, o instante da observação, porque a coluna é NOT
  // NULL e não aceita chute vazio.
  const statusDate = page.conversation_status?.status_date ?? null;
  const messageTimestamps = messages.map((message) => Date.parse(message.occurredAt));
  const lastActivityAt =
    messageTimestamps.length > 0
      ? new Date(Math.max(...messageTimestamps)).toISOString()
      : statusDate === null
        ? observedAtIso
        : new Date(statusDate).toISOString();

  // O comprador REAL, nunca o agente e nunca o vendedor. Numa conversa só com
  // o agente isto fica null — é a resposta correta, não uma falha: D-083 proíbe
  // derivar identidade de `from`/`to`, e um ID de agente aqui viraria um
  // "cliente" compartilhado por toda a operação.
  const customerExternalId =
    messages.find((message) => message.senderKind === "CUSTOMER")?.remoteFromUserId ??
    messages.find(
      (message) =>
        message.senderKind === "SELLER" &&
        message.remoteToUserId !== null &&
        message.remoteToUserId !== reference.sellerId &&
        !MESSAGING_AGENT_USER_IDS.has(message.remoteToUserId),
    )?.remoteToUserId ??
    null;

  const availability = conversationReplyState(page.conversation_status);

  return {
    case: {
      channel: "POST_SALE_MESSAGE",
      externalCaseKey: `${keyPrefix}${reference.id}`,
      externalCaseId: reference.id,
      packId: reference.kind === "PACK" ? Number(reference.id) : null,
      externalStatus: page.conversation_status?.status ?? null,
      externalSubstatus: page.conversation_status?.substatus ?? null,
      customerExternalId,
      conversationPath: page.conversation_status?.path ?? null,
      remoteUnreadCount: unreadCount,
      remoteReplyState: availability.state,
      remoteReplyBlockReason: availability.reason,
      initialInternalStatus: "NOVO",
      initialPriority: "NORMAL",
      lastActivityAt,
      lastInboundAt:
        inboundTimestamps.length === 0
          ? null
          : new Date(Math.max(...inboundTimestamps)).toISOString(),
      lastOutboundAt:
        outboundTimestamps.length === 0
          ? null
          : new Date(Math.max(...outboundTimestamps)).toISOString(),
      // Uma conversa pós-venda não tem "respondida" remota como a Pergunta tem.
      // Resolver é decisão humana da triagem (D-094), não estado do Mercado Livre.
      initialResolvedAt: null,
    },
    messages,
  };
}

const CONVERSATION_RESOURCE_PATTERN = /^\/packs\/([0-9]+)\/sellers\/([0-9]+)$/;

/**
 * Lê `results[].resource` de `/messages/unread`, que a documentação mostra
 * como `"/packs/1977056109/sellers/378136913"`. Formato diferente disso é
 * devolvido como `null` para o chamador registrar e seguir — uma conversa
 * ilegível não pode derrubar a reconciliação das outras.
 */
export function parseConversationResource(
  resource: string,
): { packOrOrderId: string; sellerId: number } | null {
  const match = CONVERSATION_RESOURCE_PATTERN.exec(resource.trim());

  if (match === null) {
    return null;
  }

  const [, packOrOrderId, seller] = match;

  if (packOrOrderId === undefined || seller === undefined) {
    return null;
  }

  const sellerId = Number(seller);

  if (!Number.isSafeInteger(sellerId) || sellerId <= 0) {
    return null;
  }

  return { packOrOrderId, sellerId };
}

export interface FetchPackMessagesOptions {
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
  /** Pack, ou o `order_id` quando o pack é nulo — o segmento continua `/packs`. */
  packOrOrderId: string;
  sellerId: number;
  offset?: number;
  limit?: number;
}

/**
 * Leitura de uma conversa pós-venda.
 *
 * **`mark_as_read=false` é fixo, não parâmetro.** Sem ele este GET marca as
 * mensagens como lidas no Mercado Livre — a própria documentação diz isso duas
 * vezes, e a página "Mensagens pendentes" chega a apresentar o GET sem o
 * parâmetro COMO A FORMA DE MARCAR COMO LIDA. Uma sincronização técnica não
 * pode alterar o estado operacional do vendedor: é D-083, decisão 2, e a razão
 * de a flag não ser exposta ao chamador — não existe caso de uso da ingestão
 * que queira `true`, e deixá-la configurável seria criar o acidente.
 */
export function fetchPackMessages(options: FetchPackMessagesOptions): Promise<PackMessagesPage> {
  return options.mercadoLivre.request({
    method: "GET",
    path: `/messages/packs/${options.packOrOrderId}/sellers/${String(options.sellerId)}`,
    searchParams: {
      tag: "post_sale",
      mark_as_read: false,
      offset: options.offset,
      limit: options.limit,
    },
    accessToken: options.accessToken,
    schema: packMessagesPageSchema,
  });
}

export interface FetchUnreadConversationsOptions {
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
}

/**
 * Conversas com mensagem não lida da conta autenticada.
 *
 * `role=seller` é obrigatório: a documentação é explícita em que a consulta é
 * neutra quanto ao papel e **não tem valor padrão**. Omiti-lo não devolve erro,
 * devolve resultado errado — que é pior.
 *
 * A própria documentação recomenda este recurso como redundância para
 * notificações perdidas. Aqui ele é mais que redundância: enquanto o painel do
 * Mercado Livre não estiver configurado, o webhook não chega (D-091) e esta é
 * a ÚNICA porta por onde uma mensagem entra.
 */
export function fetchUnreadConversations(
  options: FetchUnreadConversationsOptions,
): Promise<UnreadConversations> {
  return options.mercadoLivre.request({
    method: "GET",
    path: "/messages/unread",
    searchParams: { role: "seller", tag: "post_sale" },
    accessToken: options.accessToken,
    schema: unreadConversationsSchema,
  });
}

/**
 * Localizador devolvido por `GET /messages/{message_id}`: qual conversa aquela
 * mensagem pertence.
 *
 * O endpoint tem DUAS respostas documentadas na mesma página — "sem header"
 * (objeto plano, com `message_id`/`resource`/`resource_id`) e "atualizada (com
 * header)" (o mesmo envelope da conversa). **A documentação não diz qual
 * header seleciona qual formato**, então aceitar os dois não é excesso de zelo:
 * é a única forma de não depender de um detalhe que a fonte oficial omite.
 */
export interface MessageConversationLocator {
  messageId: string;
  kind: "PACK" | "ORDER" | null;
  packOrOrderId: string | null;
}

const legacyMessageDetailSchema = z.object({
  message_id: z.string().min(1),
  resource: z.string().min(1).nullable().default(null),
  resource_id: z.union([z.number().int(), z.string()]).nullable().default(null),
});

export const messageDetailSchema = z.union([
  packMessagesPageSchema.refine((page) => page.messages.length > 0, {
    message: "detalhe de mensagem sem messages[]",
  }),
  legacyMessageDetailSchema,
]);

/**
 * Zeros à esquerda viram case duplicado: `00123` e `123` são o mesmo pack para
 * o Mercado Livre, mas duas `external_case_key` diferentes para nós. O exemplo
 * oficial traz literalmente `"000011122344"`, então isto não é hipótese.
 */
function normalizeRemoteId(value: string): string | null {
  const digits = value.trim();

  if (!/^[0-9]+$/.test(digits)) {
    return null;
  }

  const normalized = digits.replace(/^0+/, "");

  return normalized === "" ? null : normalized;
}

function locatorFromResources(message: PackMessage): {
  kind: "PACK" | "ORDER" | null;
  packOrOrderId: string | null;
} {
  for (const resource of message.message_resources) {
    const name = resource.name.trim().toLowerCase();
    const id = normalizeRemoteId(resource.id);

    if (id === null) {
      continue;
    }

    if (name === "packs" || name === "pack") {
      return { kind: "PACK", packOrOrderId: id };
    }

    if (name === "orders" || name === "order") {
      return { kind: "ORDER", packOrOrderId: id };
    }
  }

  return { kind: null, packOrOrderId: null };
}

export function toMessageConversationLocator(
  detail: z.infer<typeof messageDetailSchema>,
): MessageConversationLocator {
  if ("messages" in detail) {
    const [message] = detail.messages;

    // O schema já exige `messages` não vazio; a guarda mantém a função segura
    // para chamadores TypeScript que montem o objeto sem executar `.parse()`.
    if (message === undefined) {
      return { messageId: "", kind: null, packOrOrderId: null };
    }

    return { messageId: message.id, ...locatorFromResources(message) };
  }

  const resource = detail.resource === null ? "" : detail.resource.trim().toLowerCase();
  const resourceId =
    detail.resource_id === null ? null : normalizeRemoteId(String(detail.resource_id));

  if (resourceId === null) {
    return { messageId: detail.message_id, kind: null, packOrOrderId: null };
  }

  if (resource === "packs" || resource === "pack") {
    return { messageId: detail.message_id, kind: "PACK", packOrOrderId: resourceId };
  }

  if (resource === "orders" || resource === "order") {
    return { messageId: detail.message_id, kind: "ORDER", packOrOrderId: resourceId };
  }

  return { messageId: detail.message_id, kind: null, packOrOrderId: null };
}

export interface FetchMessageDetailOptions {
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
  messageId: string;
}

/**
 * Detalhe de uma mensagem. Usado só para descobrir a QUAL conversa ela
 * pertence: o webhook do tópico `messages` entrega o ID da mensagem, e o que
 * a V3 persiste é sempre a conversa inteira, nunca a mensagem solta.
 */
export function fetchMessageDetail(
  options: FetchMessageDetailOptions,
): Promise<z.infer<typeof messageDetailSchema>> {
  return options.mercadoLivre.request({
    method: "GET",
    path: `/messages/${options.messageId}`,
    searchParams: { tag: "post_sale" },
    accessToken: options.accessToken,
    schema: messageDetailSchema,
  });
}
