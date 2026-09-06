/**
 * Resumo de custo de um pedido de compra — puro, testável sem React nem banco.
 *
 * **Extraído porque havia um defeito, não por antecipação** (`docs/ARCHITECTURE.md`
 * §1). O cálculo morava inline em `/compras/[id]` e somava
 * `item.unit_cost ?? 0`: um item com custo DESCONHECIDO entrava no total como
 * R$ 0,00. A tela se contradizia consigo mesma — a linha do item mostrava "—"
 * para o mesmo custo que o total tratava como zero — e o resultado era um
 * "Valor estimado" MENOR que o real, com aparência de número fechado.
 *
 * `unit_cost` é anulável por desenho (`purchase_order_items`:
 * `unit_cost is null or unit_cost >= 0`), então o caso não é hipotético: é o
 * estado normal de um rascunho em que o custo ainda não foi negociado.
 *
 * A regra é D-067: **ausência de dado não vira zero.**
 */

export interface PurchaseOrderCostInput {
  readonly quantity_ordered: number;
  readonly unit_cost: number | null;
}

export interface PurchaseOrderCostSummary {
  /**
   * Soma de `quantidade × custo` SOMENTE dos itens que têm custo.
   *
   * `null` quer dizer "desconhecido", e cobre dois casos distintos que a tela
   * mostra igual: falha de leitura, e pedido com itens em que NENHUM tem
   * custo. Um pedido genuinamente vazio (zero itens) devolve `0` — aí o total
   * é conhecido, e é zero mesmo.
   */
  readonly total: number | null;
  /** Quantos itens entraram sem custo — a ressalva de `docs/METRICS.md` 5C.2. */
  readonly missingCost: number;
  readonly totalItems: number;
}

export function summarizePurchaseOrderCost(
  items: readonly PurchaseOrderCostInput[] | null,
): PurchaseOrderCostSummary {
  // Falha de leitura: "—" no topo, nunca "0 itens, R$ 0,00" — que se lê como
  // um pedido vazio de verdade em vez de um erro (o defeito que D-067 nível 1
  // corrigiu nesta mesma tela).
  if (items === null) {
    return { total: null, missingCost: 0, totalItems: 0 };
  }

  const withCost = items.filter((item) => item.unit_cost !== null);
  const missingCost = items.length - withCost.length;

  // Itens existem, mas nenhum tem custo: o total é DESCONHECIDO. `reduce`
  // sobre lista vazia devolveria 0, e "R$ 0,00" afirmaria um pedido sem valor
  // onde o que há é um pedido sem custo preenchido.
  if (withCost.length === 0 && items.length > 0) {
    return { total: null, missingCost, totalItems: items.length };
  }

  const total = withCost.reduce(
    (soma, item) => soma + item.quantity_ordered * (item.unit_cost ?? 0),
    0,
  );

  return { total, missingCost, totalItems: items.length };
}

/** A ressalva ao lado do número; `null` quando todos os itens têm custo. */
export function purchaseOrderCostNote(summary: PurchaseOrderCostSummary): string | null {
  if (summary.missingCost === 0) return null;

  return `${String(summary.missingCost)} de ${String(summary.totalItems)} sem custo`;
}
