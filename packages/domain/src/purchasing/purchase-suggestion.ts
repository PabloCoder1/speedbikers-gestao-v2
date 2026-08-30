import { simulateRequiredQuantity } from "../inventory/coverage-simulation.js";
import { demandWindowDays } from "./replenishment-policy.js";
import type { ResolvedReplenishmentPolicy } from "./replenishment-policy.js";
import type { SalesTrendResult } from "./sales-trend.js";
import type { UsableStockResult } from "./usable-stock.js";

/**
 * Sugestão de compra auditável (D-147, Fase 5D) — o coração da fase, e a
 * composição das três peças que a precederam. Definição normativa em
 * `docs/METRICS.md` §5D.3.
 *
 * ## A conta inteira, visível
 *
 *   demanda/dia × janela de demanda = demanda projetada
 *   demanda projetada − estoque aproveitável = sugestão   (piso em zero)
 *
 * - **demanda/dia é a taxa dos últimos 30 dias** (`rateRecent` da tendência,
 *   D-145) — a mesma janela que a classificação chama de "recente". Usar 90
 *   dias diluiria o regime antigo que a tendência pode já ter declarado morto;
 *   usar 15 amplificaria ruído. A tendência aparece AO LADO como contexto e
 *   NUNCA altera o número — modulá-la seria um segundo botão escondido.
 * - **a janela de demanda vem da política** (D-144): prazo + cobertura +
 *   segurança. O prazo SOMA — comprar 15 dias de estoque com 15 de prazo zera
 *   antes da entrega, a armadilha que o PRD nomeia.
 * - **a projeção reusa `simulateRequiredQuantity`** (D-080) — regra da fórmula
 *   única: `ceil(dias × taxa)`, o mesmo arredondamento do simulador.
 * - **o aproveitável entra como está** (D-146): LOCAL negativo AUMENTA a
 *   sugestão (unidades devidas também precisam ser compradas), e RESERVADO já
 *   ficou fora lá.
 * - **zero é resposta**, não recusa: aproveitável cobrindo a janela significa
 *   "não compre" — excesso como estado próprio é item aberto da fase.
 *
 * ## As recusas se propagam, e TODAS aparecem
 *
 * Cada peça carrega a sua: sem configuração aplicável (D-144), estoque
 * virtual (D-146/D-127), histórico furado ou amostra insuficiente (D-145).
 * A lista traz todas as recusas aplicáveis, não só a primeira — quem
 * configurar a marca de um SKU virtual descobriria só depois que ainda falta
 * o ensaio de `/produtos`; a decomposição parcial continua exposta para a
 * tela mostrar o que já dá para ver.
 */

export type PurchaseSuggestionRefusal =
  | "SEM_CONFIGURACAO"
  | "ESTOQUE_VIRTUAL"
  | "HISTORICO_INCOMPLETO"
  | "AMOSTRA_INSUFICIENTE";

export interface PurchaseSuggestionInput {
  /** `null` = nenhuma configuração aplicável (D-144) — recusa, nunca default. */
  readonly policy: ResolvedReplenishmentPolicy | null;
  readonly trend: SalesTrendResult;
  readonly usable: UsableStockResult;
}

/** A decomposição visível — "por que comprar 48?" é esta conta, campo a campo. */
export interface PurchaseSuggestionBreakdown {
  /** Unidades/dia dos últimos 30 dias (a janela "recente" da tendência). */
  readonly dailyRate: number;
  /** prazo + cobertura + segurança (D-144); nulo sem configuração. */
  readonly demandWindowDays: number | null;
  /** `ceil(dailyRate × demandWindowDays)` via `simulateRequiredQuantity` (D-080). */
  readonly projectedDemand: number | null;
  /** Total de D-146; nulo para SKU virtual (a recusa de lá). */
  readonly usableStock: number | null;
}

export interface PurchaseSuggestionResult {
  /** Vazia = o número é defensável. Traz TODAS as recusas aplicáveis. */
  readonly refusals: readonly PurchaseSuggestionRefusal[];
  /** Unidades a comprar; `null` sob recusa. Zero é "não compre", não erro. */
  readonly suggestedQuantity: number | null;
  readonly breakdown: PurchaseSuggestionBreakdown;
}

export function computePurchaseSuggestion(input: PurchaseSuggestionInput): PurchaseSuggestionResult {
  const refusals: PurchaseSuggestionRefusal[] = [];

  if (input.policy === null) refusals.push("SEM_CONFIGURACAO");
  if (input.usable.total === null) refusals.push("ESTOQUE_VIRTUAL");
  if (input.trend.trend === "HISTORICO_INCOMPLETO") refusals.push("HISTORICO_INCOMPLETO");
  if (input.trend.trend === "AMOSTRA_INSUFICIENTE") refusals.push("AMOSTRA_INSUFICIENTE");

  const dailyRate = input.trend.rateRecent;
  const windowDays = input.policy === null ? null : demandWindowDays(input.policy);
  const projectedDemand =
    windowDays === null ? null : simulateRequiredQuantity(windowDays, dailyRate).requiredQuantity;

  const breakdown: PurchaseSuggestionBreakdown = {
    dailyRate,
    demandWindowDays: windowDays,
    projectedDemand,
    usableStock: input.usable.total,
  };

  if (refusals.length > 0 || projectedDemand === null || input.usable.total === null) {
    return { refusals, suggestedQuantity: null, breakdown };
  }

  return {
    refusals,
    // `ceil` pelo aproveitável fracionário (o ledger é numeric): faltando 0,4
    // unidade, compra-se 1 — o mesmo lado conservador de D-080.
    suggestedQuantity: Math.max(0, Math.ceil(projectedDemand - input.usable.total)),
    breakdown,
  };
}
