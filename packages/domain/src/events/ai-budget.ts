import { EVENT_SEVERITY } from "./catalog.js";
import type { DomainEventDraft } from "./order-events.js";

/**
 * Aviso de orçamento de IA (D-100) — a peça pura do mecanismo decidido em
 * D-082 (teto mensal, política "avisa, não bloqueia"). O worker soma o mês
 * via `get_ai_monthly_cost_usd` (SQL, `docs/ARCHITECTURE.md` secao 21) e
 * esta função só INTERPRETA o número pronto — mesma divisão de trabalho de
 * `computeLedgerIntegrityDivergences`.
 *
 * "Ultrapassar" é estritamente maior que o teto: bater exatamente no valor
 * ainda está dentro do combinado.
 *
 * O `dedupKey` embute organização e mês (`domain_events.dedup_key` é
 * UNIQUE GLOBAL, não por organização) — o job roda diariamente, mas o
 * segundo dia acima do teto no MESMO mês é deduplicado em silêncio pelo
 * banco (`recordDomainEvents`, `ignoreDuplicates`): um aviso por
 * organização por mês, sem estado extra em lugar nenhum. No mês seguinte a
 * chave muda sozinha e o aviso volta a valer.
 */

export interface AiBudgetSignal {
  readonly organizationId: string;
  /** Mês de negócio "YYYY-MM" (America/Sao_Paulo) — vira parte do dedupKey. */
  readonly month: string;
  readonly monthCostUsd: number;
  readonly budgetUsd: number;
}

export function evaluateAiBudget(signal: AiBudgetSignal, occurredAt: Date): DomainEventDraft | null {
  if (!Number.isFinite(signal.budgetUsd) || signal.budgetUsd <= 0) {
    throw new RangeError("budgetUsd precisa ser um número positivo.");
  }

  if (!Number.isFinite(signal.monthCostUsd) || signal.monthCostUsd < 0) {
    throw new RangeError("monthCostUsd precisa ser um número não negativo.");
  }

  if (signal.monthCostUsd <= signal.budgetUsd) {
    return null;
  }

  const eventType = "ai.budget.exceeded";

  return {
    eventType,
    entityType: "organization",
    entityId: signal.organizationId,
    before: { month: signal.month, budgetUsd: signal.budgetUsd },
    after: { month: signal.month, budgetUsd: signal.budgetUsd, monthCostUsd: signal.monthCostUsd },
    severity: EVENT_SEVERITY[eventType] ?? "importante",
    source: "system",
    dedupKey: `ai-budget:${signal.organizationId}:${signal.month}`,
    occurredAt,
  };
}
