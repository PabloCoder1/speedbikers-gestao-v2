import type { UsableStockResult } from "./usable-stock.js";

/**
 * O pedido já feito na linha da reposição (D-763).
 *
 * A sugestão NÃO é recalculada aqui. O pedido feito (ORDERED) já está no
 * TRANSITO do ledger, e o TRANSITO já está no aproveitável que a sugestão
 * desconta (`composeSkuReplenishment`). Esta peça só LÊ o resultado e diz o
 * que ele significa para quem compra:
 *
 * - a situação: sem pedido, só planejado, encomendado e coberto, ou
 *   encomendado com compra complementar;
 * - o risco até a chegada: ter comprado não é ter para vender. O estoque SEM o
 *   trânsito, no ritmo atual, cobre os dias até a previsão? Previsão vencida
 *   é atraso; sem previsão, o risco é desconhecido e dito assim.
 *
 * Planejado (rascunho/aprovado) não tem trânsito e não reduz nada: é só
 * indicação de que alguém já começou a montar o pedido.
 */

export type OpenPurchaseSituation =
  /** Quem lê não tem acesso aos pedidos de compra: desconhecido, nunca "sem pedido". */
  | "DESCONHECIDA"
  | "SEM_PEDIDO"
  /** Só rascunho/aprovado: a necessidade continua inteira. */
  | "PLANEJADO"
  /** Encomendado e a sugestão chegou a zero: nada novo a comprar por enquanto. */
  | "ENCOMENDADO_COBRE"
  /** Encomendado e ainda falta: a sugestão é a quantidade complementar. */
  | "ENCOMENDADO_COMPLEMENTAR"
  /** Encomendado, mas a sugestão foi recusada (sem configuração, virtual, histórico). */
  | "ENCOMENDADO_SEM_SUGESTAO";

export type ArrivalRiskKind =
  | "ATRASADO"
  | "RUPTURA_ANTES_DA_CHEGADA"
  | "CHEGA_A_TEMPO"
  | "SEM_PREVISAO"
  /** Estoque virtual ou sem venda: não há taxa para projetar a ruptura. */
  | "INDETERMINADO";

export interface OpenPurchaseInput {
  /** Pedido feito ainda a chegar (pedido − recebido). `null` = desconhecido. */
  readonly pendingQuantity: number | null;
  /** Rascunho e aprovado. `null` = desconhecido. */
  readonly plannedQuantity: number | null;
  /** Data de negócio (AAAA-MM-DD) da próxima previsão de chegada, ou `null`. */
  readonly nextExpectedDate: string | null;
  readonly late: boolean | null;
  /** A sugestão da composição canônica (já líquida do trânsito). */
  readonly suggestedQuantity: number | null;
  readonly usable: UsableStockResult;
  /** Venda média diária da composição canônica (30 dias). */
  readonly dailyRate: number;
  /** Data de negócio de hoje (AAAA-MM-DD). */
  readonly today: string;
}

export interface ArrivalRisk {
  readonly kind: ArrivalRiskKind;
  /** Dias até a previsão (negativo = vencida). `null` sem previsão. */
  readonly daysUntilArrival: number | null;
  /** Quantos dias o estoque SEM o trânsito aguenta no ritmo atual. `null` = sem base. */
  readonly coverageWithoutTransitDays: number | null;
}

export interface OpenPurchaseResult {
  readonly situation: OpenPurchaseSituation;
  /** `null` quando não há pedido feito pendente. */
  readonly risk: ArrivalRisk | null;
}

const DAY_MS = 86_400_000;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function assessArrivalRisk(input: OpenPurchaseInput): ArrivalRisk {
  const daysUntilArrival = input.nextExpectedDate === null ? null : daysBetween(input.today, input.nextExpectedDate);

  const semTransito = input.usable.total === null ? null : input.usable.total - input.usable.components.transit;
  const coverageWithoutTransitDays =
    semTransito === null || input.dailyRate <= 0 ? null : Math.max(semTransito, 0) / input.dailyRate;

  if (input.late === true || (daysUntilArrival !== null && daysUntilArrival < 0)) {
    return { kind: "ATRASADO", daysUntilArrival, coverageWithoutTransitDays };
  }

  if (daysUntilArrival === null) {
    return { kind: "SEM_PREVISAO", daysUntilArrival, coverageWithoutTransitDays };
  }

  if (coverageWithoutTransitDays === null) {
    return { kind: "INDETERMINADO", daysUntilArrival, coverageWithoutTransitDays };
  }

  return {
    kind: coverageWithoutTransitDays < daysUntilArrival ? "RUPTURA_ANTES_DA_CHEGADA" : "CHEGA_A_TEMPO",
    daysUntilArrival,
    coverageWithoutTransitDays,
  };
}

export function assessOpenPurchase(input: OpenPurchaseInput): OpenPurchaseResult {
  if (input.pendingQuantity === null || input.plannedQuantity === null) {
    return { situation: "DESCONHECIDA", risk: null };
  }

  if (input.pendingQuantity > 0) {
    const situation: OpenPurchaseSituation =
      input.suggestedQuantity === null
        ? "ENCOMENDADO_SEM_SUGESTAO"
        : input.suggestedQuantity > 0
          ? "ENCOMENDADO_COMPLEMENTAR"
          : "ENCOMENDADO_COBRE";

    return { situation, risk: assessArrivalRisk(input) };
  }

  return { situation: input.plannedQuantity > 0 ? "PLANEJADO" : "SEM_PEDIDO", risk: null };
}
