import type { ParsedClaim } from "./claim-schema.js";

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

/** A doc oficial: só `dispute` tem "representante do Mercado Livre" intervindo. */
const MEDIATION_STAGE = "dispute";

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
