/**
 * A aba Vendas do SKU com a Shopee (D-618), sobre o contrato C-71 do A1
 * (D-607): `get_sku_sales_daily_by_marketplace` (o dia a dia por canal) e
 * `get_shopee_orders` com `p_sku_id` (os pedidos da Shopee com o SKU).
 *
 * O grão é o do C-59: o `sku_id` gravado no item. O kit conta como o kit, e a
 * página de um componente não vê a venda do kit que o contém. Aqui mora só a
 * forma (a página da lista, o endereço de cada página); **nada aqui soma** — o
 * total do dia e as unidades do SKU no pedido chegam prontos do SQL.
 */

import { buildFilterHref, summarizePagedWindow, type PagedWindow } from "./filters";

/** Uma linha de `get_sku_sales_daily_by_marketplace`: canal sem venda no dia é NULO, nunca zero. */
export interface DiaDoSkuPorCanal {
  readonly dia: string;
  readonly unidades_ml: number | null;
  readonly receita_ml: number | null;
  readonly unidades_shopee: number | null;
  readonly receita_shopee: number | null;
  readonly itens_shopee_sem_receita: number | null;
  readonly unidades: number;
  /** NULA sem receita conhecida no dia. */
  readonly receita_bruta: number | null;
}

/** As colunas de `get_shopee_orders` (com `p_sku_id`) que a lista do SKU mostra. */
export interface PedidoShopeeDoSku {
  readonly shopee_shop_id: string;
  readonly shop_name: string | null;
  readonly environment: string;
  readonly order_sn: string;
  readonly order_status: string;
  readonly situacao: string;
  readonly dia: string;
  readonly unidades_do_sku: number | null;
  /** NULA quando algum item do SKU no pedido tem preço 0 (receita desconhecida). */
  readonly receita_do_sku: number | null;
  readonly total_count: number;
}

/** Os pedidos por página: a lista é um atalho do SKU, não a tela de pedidos. */
export const PEDIDOS_DO_SKU_POR_PAGINA = 20;

/** O parâmetro da página da lista na URL do SKU (`?aba=vendas&pedidos=2`). */
export const PARAMETRO_DA_PAGINA = "pedidos";

/** A página da URL: inteiro de 1 em diante; qualquer outra coisa é a primeira. */
export function paginaDosPedidos(raw: string | string[] | undefined): number {
  if (typeof raw !== "string" || !/^\d{1,6}$/u.test(raw)) return 1;

  const pagina = Number(raw);

  return pagina >= 1 ? pagina : 1;
}

/** O endereço de uma página da lista, na aba Vendas do SKU. */
export function hrefDaPaginaDosPedidos(skuId: string, pagina: number): string {
  return buildFilterHref(`/skus/${skuId}`, { aba: "vendas", [PARAMETRO_DA_PAGINA]: pagina > 1 ? String(pagina) : null }, 1);
}

/** A frase da janela ("21–40 de 57 pedidos"), a mesma das outras listas paginadas. */
export function janelaDosPedidos(pagina: number, totalCount: number, linhasNaPagina: number): PagedWindow {
  return summarizePagedWindow({
    page: pagina,
    totalCount,
    rowsOnPage: linhasNaPagina,
    pageSize: PEDIDOS_DO_SKU_POR_PAGINA,
    noun: { singular: "pedido", plural: "pedidos" },
    emptyLabel: "Nenhum pedido da Shopee com este SKU no período.",
  });
}
