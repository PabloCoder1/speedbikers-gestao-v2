import type { DomainEventDraft } from "./order-events.js";

/**
 * Eventos de atendimento (Fase 7B, D-110) — a ponte entre o domínio
 * `support` e a cadeia de notificações da Fase 7.
 *
 * **Vocabulário separado de `support_case_events` de propósito** (D-095
 * decisão 4): `support.case.auto_resolved` e afins são auditoria interna do
 * case, com mapa de rótulos próprio na UI. O que entra AQUI vira notificação
 * para gente — e por isso a barra é outra.
 *
 * A fatia 1 tem UM evento, e o corte foi medido, não estimado (D-110):
 *
 * - `support.claim.disputed` (mediação observada): **17/dia** medidos.
 *   Entra como `importante` — o desenho original propunha `critico`, mas 17
 *   críticos/dia destruiria o significado de crítico na primeira semana; o
 *   catálogo reserva esse nível para dado errado/sincronização morta.
 * - `support.claim.opened` (qualquer claim novo): **35/dia** medidos. FICA
 *   FORA. `domain_events` é append-only: errar por menos é reversível,
 *   errar por mais deixa ~1.000 linhas/mês na Central para sempre.
 */

/** Mesmo literal em todo lugar — typo em `entity_type` entra no banco sem erro. */
export const SUPPORT_CASE_ENTITY_TYPE = "support_case";

export const SUPPORT_CLAIM_DISPUTED_EVENT = "support.claim.disputed";

export interface ClaimSupportEventInput {
  supportCaseId: string;
  externalCaseId: string;
  externalStatus: string;
  externalStage: string | null;
  externalType: string;
  isMediation: boolean;
  /** Nasce `RESOLVIDO` quando o claim já chegou fechado — não notifica. */
  initialInternalStatus: "NOVO" | "RESOLVIDO";
  /** `claim.date_created` (relógio do Mercado Livre); null quando o payload não trouxe. */
  openedAt: string | null;
  /** `claim.last_updated ?? date_created` — proxy declarado do instante da mediação. */
  lastActivityAt: string;
  /**
   * Época de notificação: só claim NASCIDO a partir daqui notifica. É o
   * `max(SUPPORT_EVENTS_EPOCH, ml_accounts.connected_at)` calculado pelo
   * chamador — teste POR CLAIM, nunca por execução (D-110: as três falhas
   * bloqueantes do desenho original eram todas variações de derivar o
   * silêncio do estado da EXECUÇÃO, que sobrevive mal a `partial`, conta
   * nova e checkpoint congelado).
   */
  notifyEpoch: string;
}

/**
 * Decide se a observação de um claim vira evento de mediação. Pura: quem
 * chama resolve o que fazer com o rascunho.
 *
 * Retorna no máximo UM rascunho, com chave TERMINAL
 * (`support.claim.disputed:{caseId}`): uma mediação notifica uma vez na
 * vida do case. Webhook e varredura convergem para a mesma linha — mesmo
 * raciocínio de `auto-resolve:{caseId}` em `remote-transition.ts`. Chave
 * com timestamp aqui produziria uma notificação POR VARREDURA para cada uma
 * das 126 mediações abertas medidas hoje: a avalanche exata da V2.
 */
export function detectClaimSupportEvents(input: ClaimSupportEventInput): DomainEventDraft[] {
  if (!input.isMediation) {
    return [];
  }

  // Claim que já chegou encerrado não gera trabalho — notificar seria
  // avisar de um incêndio já apagado.
  if (input.initialInternalStatus !== "NOVO") {
    return [];
  }

  // Sem nascimento conhecido não há como aplicar a época; o silêncio é a
  // direção segura e o chamador loga a supressão para o contador ser visível.
  if (input.openedAt === null) {
    return [];
  }

  // Por Date, NUNCA lexicográfico: o Mercado Livre carimba com offset
  // (`-04:00`/`-03:00`) e a época vem em `Z`. Comparar as strings suprimiria
  // um claim nascido às `18:30-04:00` (= 22:30Z) contra uma época de 21:00Z.
  if (new Date(input.openedAt).getTime() < new Date(input.notifyEpoch).getTime()) {
    return [];
  }

  return [
    {
      eventType: SUPPORT_CLAIM_DISPUTED_EVENT,
      entityType: SUPPORT_CASE_ENTITY_TYPE,
      entityId: input.supportCaseId,
      before: null,
      after: {
        externalCaseId: input.externalCaseId,
        externalStatus: input.externalStatus,
        externalStage: input.externalStage,
        externalType: input.externalType,
        isMediation: input.isMediation,
      },
      severity: "importante",
      source: "sync",
      dedupKey: `${SUPPORT_CLAIM_DISPUTED_EVENT}:${input.supportCaseId}`,
      occurredAt: new Date(input.lastActivityAt),
    },
  ];
}
