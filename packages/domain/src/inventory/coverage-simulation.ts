import { shiftBusinessDate } from "../metrics/business-date.js";

/**
 * Simulador de cobertura de estoque (Fase 7, item 10, D-080,
 * `docs/PRODUCT_REQUIREMENTS.md` secao "Simulador de decisão"): "cobertura
 * com determinado estoque", "data estimada de ruptura conforme premissa
 * explícita", "quantidade necessária para X dias de cobertura" — as três
 * primeiras perguntas do requisito são a MESMA fórmula
 * (`cobertura = estoque / venda_média_diária`) resolvida para uma
 * incógnita diferente cada vez.
 *
 * **Mesma fórmula que `get_stock_coverage` já calcula em SQL contra dado
 * real** (`supabase/migrations/20260823175030_create_stock_coverage_rpc.sql`,
 * `days_of_coverage = local_quantity / avg_daily_sales`, arredondado a 1
 * casa) — aqui aplicada a um estoque/venda HIPOTÉTICO informado pelo
 * usuário, não ao dado real do banco. Regra da fórmula única
 * (`docs/ARCHITECTURE.md` secao 7): o mesmo cálculo, não duas versões
 * podendo divergir.
 *
 * **A quarta pergunta do requisito — "margem aproximada... quando custos
 * estiverem disponíveis" — fica de fora desta fatia de propósito.**
 * `docs/METRICS.md` já registra que "margem depende de custo cadastrado
 * por SKU", e isso não existe no schema hoje (só `unit_cost` por PEDIDO de
 * compra individual, sem consolidação por SKU) — não há base matemática
 * confiável para simular, exatamente a condição que o próprio requisito
 * já antecipava.
 *
 * **"Toda simulação deve exibir as premissas e nunca ser apresentada como
 * certeza"** (requisito original) — por isso cada função devolve a
 * premissa usada junto do resultado, nunca só o número isolado.
 */

/** Venda média diária zero (ou negativa) torna a cobertura indefinida — nunca finge um número. */
function computeCoverageDays(stockQuantity: number, avgDailySales: number): number | null {
  if (avgDailySales <= 0) return null;

  return Math.round((stockQuantity / avgDailySales) * 10) / 10;
}

function assertNonNegative(value: number, label: string): void {
  if (value < 0) {
    throw new RangeError(`${label} não pode ser negativo`);
  }
}

export interface CoverageSimulation {
  readonly stockQuantity: number;
  readonly avgDailySales: number;
  /** `null` = venda média diária zero, cobertura indefinida (não é "infinita" fingida). */
  readonly coverageDays: number | null;
}

/** "Cobertura com determinado estoque": dado um estoque hipotético e uma venda média diária, quantos dias de cobertura. */
export function simulateCoverageDays(stockQuantity: number, avgDailySales: number): CoverageSimulation {
  assertNonNegative(stockQuantity, "estoque");
  assertNonNegative(avgDailySales, "venda média diária");

  return { stockQuantity, avgDailySales, coverageDays: computeCoverageDays(stockQuantity, avgDailySales) };
}

export interface RequiredQuantitySimulation {
  readonly targetDays: number;
  readonly avgDailySales: number;
  readonly requiredQuantity: number;
}

/** "Quantidade necessária para X dias de cobertura": inverso de `simulateCoverageDays`. Arredonda para cima — cobertura parcial de um dia ainda é estoque insuficiente para aquele dia inteiro. */
export function simulateRequiredQuantity(targetDays: number, avgDailySales: number): RequiredQuantitySimulation {
  assertNonNegative(targetDays, "dias-alvo");
  assertNonNegative(avgDailySales, "venda média diária");

  return { targetDays, avgDailySales, requiredQuantity: Math.ceil(targetDays * avgDailySales) };
}

export interface RuptureDateSimulation {
  readonly asOf: string;
  readonly stockQuantity: number;
  readonly avgDailySales: number;
  /** `null` = venda média diária zero, ruptura não pode ser estimada. */
  readonly ruptureDate: string | null;
}

/** "Data estimada de ruptura conforme premissa explícita": `asOf` + dias de cobertura (arredondado para baixo — a data em que o estoque já não cobre mais um dia inteiro). */
export function simulateRuptureDate(asOf: string, stockQuantity: number, avgDailySales: number): RuptureDateSimulation {
  const coverage = simulateCoverageDays(stockQuantity, avgDailySales);

  return {
    asOf,
    stockQuantity,
    avgDailySales,
    ruptureDate: coverage.coverageDays === null ? null : shiftBusinessDate(asOf, Math.floor(coverage.coverageDays)),
  };
}
