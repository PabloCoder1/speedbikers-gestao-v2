/**
 * Transição automática de status interno pela atividade REMOTA (D-102) —
 * a peça pura que decide QUAL transição a ingestão pede; a execução
 * atômica (UPDATE guardado + `support_case_events`) é da RPC
 * `apply_support_remote_transition`.
 *
 * A regra vem de D-084: "primeira projeção pode nascer resolvida se já
 * respondida/encerrada, e nova atividade inbound reabre para NOVO. Fora
 * disso, sync não sobrescreve decisão humana." O "não sobrescrever" vive
 * em `expectedStatuses` — a RPC só aplica se o case ainda estiver ali.
 *
 * PERGUNTA (1 pergunta = 1 case, sem reabertura): respondida/encerrada no
 * lado remoto — pelo app do Mercado Livre ou pela própria V3 (D-096) —
 * resolve o case que ninguém triou. É a resposta direta à pergunta do
 * usuário que motivou D-102: "se já foi respondida via outra plataforma,
 * não deve aparecer como novo".
 *
 * CONVERSA (mensagens pós-venda, D-097): não existe "respondida" terminal
 * — o cliente pode voltar. Vendedor respondeu por último => o case NOVO
 * não triado vira AGUARDANDO_CLIENTE (a bola está com o cliente); cliente
 * respondeu por último => um case AGUARDANDO_CLIENTE/RESOLVIDO reabre
 * para NOVO (a regra adiada em D-086). Empate de timestamp conta como
 * "vendedor respondeu": o outbound veio depois ou junto, e reabrir num
 * empate criaria oscilação entre os dois estados na mesma releitura.
 */

export type SupportInternalStatus =
  | "NOVO"
  | "EM_ATENDIMENTO"
  | "AGUARDANDO_CLIENTE"
  | "AGUARDANDO_MERCADO_LIVRE"
  | "RESOLVIDO";

export interface SupportRemoteTransition {
  readonly expectedStatuses: readonly SupportInternalStatus[];
  readonly newStatus: SupportInternalStatus;
  readonly eventType: string;
  readonly dedupKey: string;
  /** ISO — o instante da atividade remota que justifica a transição, nunca o relógio da V3. */
  readonly occurredAt: string;
}

export interface QuestionRemoteSignal {
  readonly caseId: string;
  /** O mapper de Perguntas já decide "nasceria resolvida?" (answer presente ou status terminal). */
  readonly remotelyResolved: boolean;
  readonly resolvedAt: string | null;
  readonly lastActivityAt: string;
}

export function evaluateQuestionRemoteTransition(signal: QuestionRemoteSignal): SupportRemoteTransition | null {
  if (!signal.remotelyResolved) {
    return null;
  }

  return {
    expectedStatuses: ["NOVO"],
    newStatus: "RESOLVIDO",
    eventType: "support.case.auto_resolved",
    // Sem timestamp na chave: uma pergunta só resolve automaticamente uma
    // vez (não há reabertura de QUESTION) — webhook e reconciliação
    // convergem para a MESMA linha de evento.
    dedupKey: `auto-resolve:${signal.caseId}`,
    occurredAt: signal.resolvedAt ?? signal.lastActivityAt,
  };
}

export interface ConversationRemoteSignal {
  readonly caseId: string;
  readonly lastInboundAt: string | null;
  readonly lastOutboundAt: string | null;
}

export function evaluateConversationRemoteTransition(
  signal: ConversationRemoteSignal,
): SupportRemoteTransition | null {
  const inbound = signal.lastInboundAt;
  const outbound = signal.lastOutboundAt;

  if (outbound !== null && (inbound === null || outbound >= inbound)) {
    return {
      expectedStatuses: ["NOVO"],
      newStatus: "AGUARDANDO_CLIENTE",
      eventType: "support.case.auto_awaiting_customer",
      // O timestamp na chave permite a transição acontecer DE NOVO depois
      // de uma reabertura — cada resposta do vendedor é um fato distinto.
      dedupKey: `auto-await:${signal.caseId}:${outbound}`,
      occurredAt: outbound,
    };
  }

  if (inbound !== null && (outbound === null || inbound > outbound)) {
    return {
      expectedStatuses: ["AGUARDANDO_CLIENTE", "RESOLVIDO"],
      newStatus: "NOVO",
      eventType: "support.case.auto_reopened",
      dedupKey: `auto-reopen:${signal.caseId}:${inbound}`,
      occurredAt: inbound,
    };
  }

  return null;
}
