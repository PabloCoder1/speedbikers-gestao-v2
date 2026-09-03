import { formatCurrency } from "./format";

/**
 * Formatação da memória de decisões (Fase 6, D-064/D-065) — extraída de
 * `apps/web/app/acoes/action-row.tsx` em D-228, porque a aba `Decisões` do
 * Dashboard de SKU (um Server Component) precisa do MESMO texto que a Central
 * de Ações mostra, e um módulo `"use client"` não é lugar de onde um Server
 * Component importa função. Um formato, dois lugares: se a forma do snapshot
 * mudar, muda aqui, e as duas telas seguem dizendo a mesma coisa.
 */

/**
 * Comparação BRUTA lado a lado, nunca uma % sintetizada — mesmo raciocínio
 * de `/vendas`: `avg_price_7d`/outros podem faltar (SKU sem venda no
 * período), e o texto imprime "—" em vez de inventar zero.
 *
 * Recebe `unknown` porque `baseline_snapshot`/`outcome_snapshot` chegam como
 * `Json` do banco: o estreitamento acontece AQUI, uma vez, em vez de um cast
 * em cada tela (D-200: cast esconde qual guarda é real).
 */
export function formatDecisionSnapshot(snapshot: unknown): string {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    return "Sem dado.";
  }

  const registro = snapshot as Record<string, unknown>;

  if (Object.keys(registro).length === 0) return "Sem dado (ação sem SKU vinculado).";

  const unitsSold = registro.units_sold_7d;
  const avgPrice = registro.avg_price_7d;
  const stockLocal = registro.stock_local;

  const priceText = typeof avgPrice === "number" ? formatCurrency(avgPrice) : "—";

  return `Vendido (7d): ${String(unitsSold)} · Preço médio: ${priceText} · Estoque local: ${String(stockLocal)}`;
}

/** As três janelas que `diagnostics.measure-decision-outcomes` mede (D-065). */
export const OUTCOME_WINDOWS_DAYS: readonly number[] = [7, 15, 30];

export function outcomeWindowLabel(days: number): string {
  return `${String(days)} dias depois`;
}
