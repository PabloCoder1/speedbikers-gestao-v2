import { simulateCoverageDays } from "../inventory/coverage-simulation.js";
import { demandWindowDays } from "./replenishment-policy.js";
import type { ResolvedReplenishmentPolicy } from "./replenishment-policy.js";
import type { PurchaseSuggestionRefusal } from "./purchase-suggestion.js";
import type { SalesTrendResult } from "./sales-trend.js";
import type { UsableStockResult } from "./usable-stock.js";

/**
 * Estados operacionais calculados (D-148, Fase 5D) — os cinco do ROADMAP:
 * ruptura, compra urgente, comprar em breve, cobertura baixa/adequada,
 * excesso. Definição normativa em `docs/METRICS.md` §5D.4.
 *
 * ## Todos os limiares vêm da POLÍTICA — nenhuma constante inventada
 *
 * A régua é a cobertura em dias (`aproveitável ÷ taxa dos últimos 30 dias`,
 * a MESMA fórmula de D-080 via `simulateCoverageDays` — fórmula única),
 * comparada com os números que o ADMIN configurou (D-144):
 *
 *   RUPTURA          aproveitável ≤ 0 com demanda recente — nada para vender
 *   COMPRA_URGENTE   cobertura ≤ prazo: mesmo comprando AGORA, esgota antes
 *                    de chegar
 *   COMPRAR_EM_BREVE cobertura ≤ prazo + segurança (o ponto de pedido):
 *                    o pedido precisa sair antes de comer a margem
 *   COBERTURA_BAIXA  cobertura abaixo da janela de demanda — é o território
 *                    em que a sugestão de compra (D-147) já dá número > 0
 *   ADEQUADA         cobertura na janela, abaixo do teto (quando houver)
 *   EXCESSO          cobertura acima do TETO CONFIGURADO (`maxCoverageDays`,
 *                    o "buffer máximo" que o PRD nomeia na configuração).
 *                    Sem teto configurado, EXCESSO nunca é afirmado — "quanto
 *                    é demais" é decisão do ADMIN, não constante do código.
 *
 * ## As recusas de D-147 se propagam, mais uma própria
 *
 * Sem configuração, estoque virtual, histórico furado ou amostra
 * insuficiente: sem estado (as mesmas quatro portas da sugestão). E
 * **SEM_DEMANDA_RECENTE**: taxa zero nos últimos 30 dias torna a cobertura
 * indefinida (o contrato de D-080: nunca "infinita" fingida) — sem régua,
 * nenhum dos cinco estados é defensável. A cobertura em si é exposta sempre
 * que for computável (ela não depende da política), para a tela mostrar o
 * que já dá para ver.
 */

export type StockOperationalState =
  | "RUPTURA"
  | "COMPRA_URGENTE"
  | "COMPRAR_EM_BREVE"
  | "COBERTURA_BAIXA"
  | "ADEQUADA"
  | "EXCESSO";

export type StockStateRefusal = PurchaseSuggestionRefusal | "SEM_DEMANDA_RECENTE";

export interface StockStateInput {
  readonly policy: ResolvedReplenishmentPolicy | null;
  readonly trend: SalesTrendResult;
  readonly usable: UsableStockResult;
}

/** Os limiares usados — a decomposição visível do veredito. */
export interface StockStateThresholds {
  readonly leadTimeDays: number | null;
  /** prazo + segurança: o ponto de pedido. */
  readonly reorderPointDays: number | null;
  /** prazo + cobertura + segurança (D-144). */
  readonly demandWindowDays: number | null;
  /** O teto configurado; nulo = ADMIN ainda não definiu o que é "demais". */
  readonly maxCoverageDays: number | null;
}

export interface StockStateResult {
  /** Nulo sob recusa — sem régua defensável, nenhum selo. */
  readonly state: StockOperationalState | null;
  readonly refusals: readonly StockStateRefusal[];
  /** `aproveitável ÷ taxa 30d` em dias; nulo quando indefinida. */
  readonly coverageDays: number | null;
  readonly thresholds: StockStateThresholds;
}

export function classifyStockState(input: StockStateInput): StockStateResult {
  const refusals: StockStateRefusal[] = [];

  if (input.policy === null) refusals.push("SEM_CONFIGURACAO");
  if (input.usable.total === null) refusals.push("ESTOQUE_VIRTUAL");
  if (input.trend.trend === "HISTORICO_INCOMPLETO") refusals.push("HISTORICO_INCOMPLETO");
  if (input.trend.trend === "AMOSTRA_INSUFICIENTE") refusals.push("AMOSTRA_INSUFICIENTE");

  const thresholds: StockStateThresholds = {
    leadTimeDays: input.policy?.leadTimeDays ?? null,
    reorderPointDays: input.policy === null ? null : input.policy.leadTimeDays + input.policy.safetyStockDays,
    demandWindowDays: input.policy === null ? null : demandWindowDays(input.policy),
    maxCoverageDays: input.policy?.maxCoverageDays ?? null,
  };

  const rate = input.trend.rateRecent;

  // A cobertura não depende da política: computável sempre que há estoque
  // confiável e demanda recente — exposta mesmo sob recusa de configuração.
  const coverageDays =
    input.usable.total === null || rate <= 0
      ? null
      : simulateCoverageDays(Math.max(input.usable.total, 0), rate).coverageDays;

  if (rate <= 0 && input.usable.total !== null && refusals.length === 0) {
    refusals.push("SEM_DEMANDA_RECENTE");
  }

  if (refusals.length > 0 || input.policy === null || input.usable.total === null) {
    return { state: null, refusals, coverageDays, thresholds };
  }

  if (input.usable.total <= 0) {
    return { state: "RUPTURA", refusals, coverageDays, thresholds };
  }

  // Daqui em diante coverageDays é número: usable > 0 e rate > 0.
  const coverage = coverageDays ?? 0;

  if (coverage <= input.policy.leadTimeDays) {
    return { state: "COMPRA_URGENTE", refusals, coverageDays, thresholds };
  }

  if (coverage <= input.policy.leadTimeDays + input.policy.safetyStockDays) {
    return { state: "COMPRAR_EM_BREVE", refusals, coverageDays, thresholds };
  }

  if (coverage < demandWindowDays(input.policy)) {
    return { state: "COBERTURA_BAIXA", refusals, coverageDays, thresholds };
  }

  if (input.policy.maxCoverageDays !== null && coverage > input.policy.maxCoverageDays) {
    return { state: "EXCESSO", refusals, coverageDays, thresholds };
  }

  return { state: "ADEQUADA", refusals, coverageDays, thresholds };
}
