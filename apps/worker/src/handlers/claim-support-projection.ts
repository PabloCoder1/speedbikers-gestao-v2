import type { ParsedClaim, ParsedClaimDetail, ParsedClaimMessage } from "./claim-schema.js";

/**
 * Mapper puro claim -> projeção de atendimento (`support_cases`, canal
 * `CLAIM`). Sem I/O, sem relógio local: tudo que sai daqui vem do payload.
 *
 * Pesquisa oficial em `docs/MERCADO_LIVRE.md` secao 2.10/2.12, reconfirmada
 * ao vivo em 2026-08-27 antes desta implementação.
 */

export interface SupportClaimCaseProjection {
  channel: "CLAIM";
  externalCaseKey: string;
  externalCaseId: string;
  externalStatus: string;
  externalStage: string | null;
  externalType: string;
  isMediation: boolean;
  hasReturn: boolean;
  customerExternalId: number | null;
  remoteReplyState: "UNKNOWN" | "ALLOWED" | "BLOCKED";
  initialInternalStatus: "NOVO" | "RESOLVIDO";
  initialPriority: "ALTA" | "CRITICA";
  initialResolvedAt: string | null;
  lastActivityAt: string;
}

export interface SupportClaimProjection {
  case: SupportClaimCaseProjection;
  /** Pedido vinculado, quando o claim é sobre uma order. */
  orderId: number | null;
}

export interface SupportClaimMessageProjection {
  externalMessageKey: string;
  direction: "INBOUND" | "OUTBOUND" | "SYSTEM";
  senderKind: "CUSTOMER" | "SELLER" | "MEDIATOR" | "UNKNOWN";
  body: string | null;
  bodyState: "AVAILABLE" | "EMPTY" | "MODERATED";
  remoteStatus: string | null;
  occurredAt: string;
}

export interface SupportClaimDeadlineProjection {
  deadlineKind: "NEXT_ACTION" | "RESOLUTION";
  source: "ML_CLAIM_DETAIL" | "ML_AVAILABLE_ACTION";
  /** Nome da ação, para `ML_AVAILABLE_ACTION`; nulo para o prazo do claim. */
  sourceReference: string | null;
  startedAt: string | null;
  dueAt: string;
  status: "ACTIVE" | "CANCELLED";
}

/** A doc oficial: só `dispute` tem "representante do Mercado Livre" intervindo. */
const MEDIATION_STAGE = "dispute";

/**
 * Prazos do claim, das DUAS fontes que a API expõe (D-084: "usar o `due_date`
 * remoto exato quando presente", nunca um SLA inventado).
 *
 * - `detail.due_date` -> `RESOLUTION` / `ML_CLAIM_DETAIL`. Um por case, então
 *   `sourceReference` fica nulo e a UNIQUE (`nulls not distinct`) atualiza a
 *   MESMA linha a cada re-ingestão em vez de empilhar.
 * - `players[].available_actions[].due_date` -> `NEXT_ACTION` /
 *   `ML_AVAILABLE_ACTION`, com o NOME da ação em `sourceReference` — chave
 *   natural e estável, uma linha por tipo de ação.
 *
 * **Só as ações do VENDEDOR viram prazo.** Prazo do comprador ou do mediador
 * não é tarefa nossa, e listá-lo na Caixa de Entrada criaria urgência falsa
 * sobre trabalho de outra pessoa.
 *
 * **Claim fechado cancela os prazos** em vez de deixá-los `ACTIVE` para
 * sempre. `CANCELLED` e não `MET` porque a API não diz se o prazo foi
 * cumprido — afirmar que foi seria inventar.
 *
 * `startedAt` só existe para `RESOLUTION`, e vem da abertura do claim (é, por
 * definição, quando aquele prazo começou). Para uma ação disponível a API não
 * diz quando a janela abriu, e chutar viraria SLA falso.
 */
export function mapClaimDeadlinesToProjection(
  claim: ParsedClaim,
  detail: ParsedClaimDetail | null,
): SupportClaimDeadlineProjection[] {
  const status = claim.status === "closed" ? ("CANCELLED" as const) : ("ACTIVE" as const);
  const deadlines: SupportClaimDeadlineProjection[] = [];

  if (detail?.due_date != null && detail.due_date !== "") {
    deadlines.push({
      deadlineKind: "RESOLUTION",
      source: "ML_CLAIM_DETAIL",
      sourceReference: null,
      startedAt: claim.date_created ?? null,
      dueAt: detail.due_date,
      status,
    });
  }

  const sellerRole = resolveSellerRole(claim);

  if (sellerRole === null) {
    return deadlines;
  }

  const sellerActions = claim.players?.find((player) => player.role === sellerRole)?.available_actions ?? [];
  const seen = new Set<string>();

  for (const action of sellerActions) {
    if (action.due_date == null || action.due_date === "" || seen.has(action.action)) {
      continue;
    }

    seen.add(action.action);

    deadlines.push({
      deadlineKind: "NEXT_ACTION",
      source: "ML_AVAILABLE_ACTION",
      sourceReference: action.action,
      startedAt: null,
      dueAt: action.due_date,
      status,
    });
  }

  return deadlines;
}

/**
 * Fingerprint de mensagem de claim. **Obrigatório porque o payload oficial
 * NÃO traz `id` de mensagem** — o caminho que D-084 mandou seguir nesse caso,
 * com a proibição explícita de usar índice do array.
 *
 * Por que índice seria um bug e não só um estilo: a doc filtra em silêncio as
 * mensagens moderadas da CONTRAPARTE, então a mesma conversa pode voltar com
 * um item a menos e todos os índices seguintes deslocados — o transcript
 * inteiro se reembaralharia numa re-ingestão.
 *
 * Por que o TEXTO fica de fora da chave: `status` pode virar `moderated` e o
 * corpo mudar para a MESMA mensagem lógica. Com o texto na chave, moderar
 * criaria uma linha nova em vez de atualizar a existente — duplicando a
 * mensagem no transcript.
 *
 * Sobra `sender_role` + instante do envio. Colisão exigiria o mesmo
 * participante mandando duas mensagens no mesmo segundo; nesse caso a
 * segunda é absorvida pela UNIQUE, e perder uma duplicata exata é melhor que
 * embaralhar a conversa.
 */
export function buildClaimMessageKey(message: ParsedClaimMessage): string | null {
  const sentAt = message.message_date ?? message.date_created ?? null;

  if (sentAt === null) {
    return null;
  }

  return `claim-msg:${message.sender_role}:${sentAt}`;
}

/**
 * Nosso papel no claim sai de `players[].type === "seller"` — a doc define
 * `type` como "papel que a pessoa ocupa sobre a operação" (comprador ou
 * vendedor), enquanto `role` é o papel na RECLAMAÇÃO (quem reclama). Os dois
 * se invertem conforme o tipo do claim: em `cancel_sale` quem reclama é o
 * vendedor.
 */
function resolveSellerRole(claim: ParsedClaim): string | null {
  return claim.players?.find((player) => player.type === "seller")?.role ?? null;
}

function resolveBody(message: ParsedClaimMessage): {
  body: string | null;
  bodyState: SupportClaimMessageProjection["bodyState"];
} {
  const moderated =
    message.status === "moderated" ||
    message.status === "rejected" ||
    message.message_moderation?.status === "rejected";

  const text = message.message ?? null;

  if (moderated) {
    // Mesma regra de D-086 para conteúdo BANNED: preservar que a mensagem
    // EXISTIU e por que não está visível, em vez de renderizar bolha vazia.
    return { body: text, bodyState: "MODERATED" };
  }

  if (text === null || text.trim() === "") {
    return { body: null, bodyState: "EMPTY" };
  }

  return { body: text, bodyState: "AVAILABLE" };
}

/**
 * Mapeia o transcript. Mensagem sem instante de envio é DESCARTADA (não dá
 * para fingerprintar nem ordenar), com o mesmo raciocínio do envelope.
 */
export function mapClaimMessagesToProjection(
  claim: ParsedClaim,
  messages: readonly ParsedClaimMessage[],
): SupportClaimMessageProjection[] {
  const sellerRole = resolveSellerRole(claim);
  const projected: SupportClaimMessageProjection[] = [];

  for (const message of messages) {
    const externalMessageKey = buildClaimMessageKey(message);
    const occurredAt = message.message_date ?? message.date_created ?? null;

    if (externalMessageKey === null || occurredAt === null) {
      continue;
    }

    const { body, bodyState } = resolveBody(message);
    const common = { externalMessageKey, body, bodyState, remoteStatus: message.status ?? null, occurredAt };

    if (message.sender_role === "mediator") {
      projected.push({ ...common, direction: "SYSTEM", senderKind: "MEDIATOR" });
      continue;
    }

    // Sem conseguir identificar nosso papel, tratar como INBOUND é o erro
    // SEGURO: erra para "alguém falou conosco", nunca para "já respondemos"
    // — que poderia suprimir atenção de um atendimento em aberto.
    if (sellerRole === null) {
      projected.push({ ...common, direction: "INBOUND", senderKind: "UNKNOWN" });
      continue;
    }

    const isOurs = message.sender_role === sellerRole;

    projected.push({
      ...common,
      direction: isOurs ? "OUTBOUND" : "INBOUND",
      senderKind: isOurs ? "SELLER" : "CUSTOMER",
    });
  }

  return projected;
}

/**
 * Ações de envio de mensagem do vendedor, conforme a lista oficial de
 * `available_actions`. A doc é explícita: "O envio só é válido quando a ação
 * correspondente aparece em available_actions".
 */
const SELLER_REPLY_ACTIONS = new Set(["send_message_to_complainant", "send_message_to_mediator"]);

function resolveCustomerExternalId(claim: ParsedClaim): number | null {
  // `type` diz o papel na operação (comprador/vendedor); `role` diz o papel na
  // reclamação (quem reclama). O cliente é o COMPRADOR, mesmo quando é ele o
  // reclamado (ex.: `cancel_purchase`) — por isso o filtro é por `type`.
  const buyer = claim.players?.find((player) => player.type === "buyer");

  return buyer?.user_id ?? null;
}

function resolveReplyState(claim: ParsedClaim): "UNKNOWN" | "ALLOWED" | "BLOCKED" {
  // Sem `players` no payload não dá para afirmar nem que pode, nem que não
  // pode responder — e `UNKNOWN` é exatamente o valor que existe para isso.
  if (claim.players == null) {
    return "UNKNOWN";
  }

  const seller = claim.players.find((player) => player.role === "respondent");

  if (seller?.available_actions == null) {
    return "UNKNOWN";
  }

  const canReply = seller.available_actions.some((entry) => SELLER_REPLY_ACTIONS.has(entry.action));

  return canReply ? "ALLOWED" : "BLOCKED";
}

/**
 * Devolve `null` quando o claim não traz NENHUM carimbo de tempo do Mercado
 * Livre. `support_cases.last_activity_at` é `not null`, e a alternativa seria
 * usar o instante da consulta — precisamente o defeito que D-097 encontrou em
 * produção, achatando a ordenação inteira da Caixa de Entrada. Não projetar é
 * melhor que projetar com data inventada; o chamador registra e segue.
 */
export function mapClaimToSupportProjection(claim: ParsedClaim): SupportClaimProjection | null {
  const lastActivityAt = claim.last_updated ?? claim.date_created ?? null;

  if (lastActivityAt === null) {
    return null;
  }

  const isMediation = claim.stage === MEDIATION_STAGE;
  const internalState = resolveInternalState(claim, lastActivityAt);

  const projectedCase: SupportClaimCaseProjection = {
    channel: "CLAIM",
    externalCaseKey: `claim:${String(claim.id)}`,
    externalCaseId: String(claim.id),
    externalStatus: claim.status,
    externalStage: claim.stage ?? null,
    externalType: claim.type,
    isMediation,
    hasReturn: claim.related_entities.includes("return"),
    customerExternalId: resolveCustomerExternalId(claim),
    remoteReplyState: resolveReplyState(claim),
    initialInternalStatus: internalState.initialInternalStatus,
    initialPriority: isMediation ? "CRITICA" : "ALTA",
    initialResolvedAt: internalState.initialResolvedAt,
    lastActivityAt,
  };

  return {
    case: projectedCase,
    orderId: claim.resource === "order" ? claim.resource_id : null,
  };
}

/**
 * Claim já encerrado no Mercado Livre nasce `RESOLVIDO` — mesma regra que
 * D-086 aplicou a pergunta que chega respondida. A transição automática de
 * D-102 cuida do que muda DEPOIS.
 *
 * `resolved_at` sai de `resolution.date_created` quando existe (a data real do
 * encerramento) e cai para `lastActivityAt` quando não — nunca `now()`. A
 * constraint `support_cases_resolution_coherent` exige os dois coerentes.
 */
function resolveInternalState(
  claim: ParsedClaim,
  lastActivityAt: string,
): { initialInternalStatus: "NOVO" | "RESOLVIDO"; initialResolvedAt: string | null } {
  if (claim.status !== "closed") {
    return { initialInternalStatus: "NOVO", initialResolvedAt: null };
  }

  return {
    initialInternalStatus: "RESOLVIDO",
    initialResolvedAt: claim.resolution?.date_created ?? lastActivityAt,
  };
}
