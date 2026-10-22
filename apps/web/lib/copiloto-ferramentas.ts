/**
 * O rótulo de cada ferramenta do Copiloto no chat (`/copiloto`): a linha
 * "consultou vendas do período · comparou as contas" embaixo da resposta.
 *
 * O marcador existe para o ESCOPO ficar visível (D-293): sem ele, uma resposta
 * sobre estoque e uma sobre venda chegam iguais na tela.
 *
 * D-646: são as nove ferramentas de `apps/api/src/copilot-chat.ts`. Duas delas,
 * `sales_sku_declines` e `resolve_catalog_entity`, existiam sem rótulo e
 * apareciam com o nome cru; as duas do C-84 (A1, D-641) trazem a Shopee.
 * Ferramenta desconhecida (uma nova na api antes da tela) aparece pelo nome, em
 * vez de sumir: o operador ainda vê que ela foi usada.
 */
const ROTULO: Readonly<Record<string, string>> = {
  sales_summary: "consultou vendas do período",
  sales_period_comparison: "comparou com o período anterior",
  sales_account_comparison: "comparou as contas",
  sales_sku_declines: "consultou os SKUs que mais caíram",
  resolve_catalog_entity: "achou o SKU ou o anúncio citado",
  sku_replenishment: "consultou estoque e reposição do SKU",
  listing_performance: "consultou desempenho do anúncio",
  // C-84: as duas com a Shopee, pelas RPCs multicanal (C-53 e C-59).
  marketplace_sales_summary: "consultou vendas por canal",
  marketplace_sku_sales: "consultou os SKUs mais vendidos por canal",
};

export function rotuloDaFerramenta(ferramenta: string): string {
  return ROTULO[ferramenta] ?? ferramenta;
}
