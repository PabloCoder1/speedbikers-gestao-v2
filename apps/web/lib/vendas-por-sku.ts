/**
 * Vendas POR SKU entre os marketplaces (D-444, etapa T6a da frente
 * multicanal), sobre o contrato C-59 (D-439): `get_marketplace_sku_sales` (o
 * ranking de `/vendas` fora do recorte ML) e
 * `get_sku_sales_by_marketplace_account` (a aba Vendas do SKU por conta e loja).
 *
 * O que soma por SKU entre os canais vem somado do SQL: unidades, receita
 * bruta (o preço de linha do ML e o do item da Shopee) e compras (o pack do ML
 * e o pedido Shopee que contém o SKU). Item Shopee de preço zero (bundle) tem
 * receita DESCONHECIDA e é contado à parte — nunca zero. A loja de teste
 * aparece só na linha dela. **Nada aqui soma**: é a forma das linhas e a ordem.
 */

import type { SalesMetric } from "./sales-metric";
import type { CodigoMarketplace } from "./vendas-multicanal";

/** Quantos produtos o ranking de `/vendas` mostra — o mesmo top 10 da tela do ML. */
export const TAMANHO_DO_RANKING = 10;

/**
 * A ordem do ranking acompanha a métrica do gráfico, como na tela do ML. O
 * contrato ordena por receita ou unidades; "compras" não é ordem dele, e cai
 * na receita (a tela diz qual usou).
 */
export function ordemDoRanking(metrica: SalesMetric): "receita" | "unidades" {
  return metrica.key === "unidades" ? "unidades" : "receita";
}

/**
 * Uma linha de `get_marketplace_sku_sales`. Coluna de marketplace nula = sem
 * venda nele no período. `sku_id` nulo é o balde do que foi vendido por
 * anúncio SEM produto vinculado — o ranking do ML o deixa de fora; este o
 * mostra, marcado, porque é venda que existe.
 */
export interface LinhaDoRanking {
  readonly sku_id: string | null;
  readonly sku: string | null;
  readonly sku_title: string | null;
  readonly unidades: number;
  readonly receita_bruta: number | null;
  readonly compras: number;
  readonly unidades_ml: number | null;
  readonly receita_ml: number | null;
  readonly compras_ml: number | null;
  readonly unidades_shopee: number | null;
  readonly receita_shopee: number | null;
  readonly itens_shopee_sem_receita: number | null;
  readonly compras_shopee: number | null;
  readonly total_count: number;
}

/** Uma linha de `get_sku_sales_by_marketplace_account`. */
export interface VendaDoSkuPorConta {
  readonly nivel: "TOTAL" | "CONTA";
  readonly marketplace: CodigoMarketplace | null;
  readonly account_id: string | null;
  readonly account_name: string | null;
  readonly environment: string | null;
  readonly unidades: number;
  readonly receita_bruta: number | null;
  readonly itens_sem_receita: number;
  readonly compras: number;
  readonly preco_medio: number | null;
}

/**
 * O TOTAL (só operação: a loja de teste fica fora) e as contas, o Mercado
 * Livre primeiro e, dentro de cada canal, por nome. Sem TOTAL, nada deste SKU
 * é somável no período — e a tela diz isso em vez de mostrar zero.
 */
export function separarVendasDoSku(linhas: readonly VendaDoSkuPorConta[]): {
  total: VendaDoSkuPorConta | null;
  contas: VendaDoSkuPorConta[];
} {
  const peso = (linha: VendaDoSkuPorConta): number => (linha.marketplace === "ML" ? 0 : 1);

  return {
    total: linhas.find((linha) => linha.nivel === "TOTAL") ?? null,
    contas: linhas
      .filter((linha) => linha.nivel === "CONTA")
      .sort((a, b) => peso(a) - peso(b) || (a.account_name ?? "").localeCompare(b.account_name ?? "", "pt-BR")),
  };
}

/** Conta ou loja de teste: aparece marcada e fora do total. */
export function contaDeTeste(linha: VendaDoSkuPorConta): boolean {
  return linha.environment !== null && linha.environment !== "live";
}
