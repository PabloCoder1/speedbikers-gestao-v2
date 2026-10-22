/**
 * O diagnóstico de venda por canal (C-83 do A1, D-639; a tela é a D-644).
 *
 * Decisão do dono em 22/10: **por canal**. Cada canal é avaliado separado — uma
 * queda no Mercado Livre vira anomalia mesmo que a Shopee compense — e o
 * diagnóstico diz o canal. As três RPCs (`get_sku_sales_baseline`,
 * `get_sku_average_prices` e `get_sku_correlated_events`) recebem
 * `p_marketplaces` e devolvem `marketplace` em cada linha; o mesmo SKU pode ter
 * duas linhas, uma por canal.
 *
 * Aqui mora só a forma: a chave de um diagnóstico, o canal de cada linha e quais
 * eventos valem para qual canal. Nada aqui soma — a linha de base e o preço
 * médio chegam prontos do SQL.
 */

export type Canal = "ML" | "SHOPEE";

export const CANAL_ROTULO: Readonly<Record<Canal, string>> = {
  ML: "Mercado Livre",
  SHOPEE: "Shopee",
};

/**
 * O canal de uma linha. Antes da migration do C-83 a coluna não vem, e a linha
 * é do Mercado Livre — o único canal que a RPC conhecia. Valor desconhecido
 * também cai no ML, o resultado de antes, em vez de inventar um canal.
 */
export function canalDaLinha(marketplace: unknown): Canal {
  return marketplace === "SHOPEE" ? "SHOPEE" : "ML";
}

/** A chave de um diagnóstico: o SKU E o canal (o mesmo SKU pode ter dois). */
export function chaveDoDiagnostico(skuId: string, canal: Canal): string {
  return `${skuId}:${canal}`;
}

/**
 * Os canais que a tela pede. Só com loja Shopee visível ela manda os dois; sem
 * loja, não manda nada (`p_marketplaces` nulo é o ML de sempre), e a tela de
 * quem só tem o Mercado Livre não muda. `null` = não mandar o parâmetro.
 */
export function canaisPedidos(lojasShopee: number | null): readonly Canal[] | null {
  return lojasShopee !== null && lojasShopee > 0 ? ["ML", "SHOPEE"] : null;
}

/**
 * Se um evento correlacionado vale para o canal: o evento do SKU (estoque,
 * saldo) vem com `marketplace` nulo e vale para os dois; o do anúncio e do
 * pedido vem com o canal dele.
 */
export function eventoValeParaOCanal(marketplaceDoEvento: unknown, canal: Canal): boolean {
  if (marketplaceDoEvento === null || marketplaceDoEvento === undefined) return true;

  return canalDaLinha(marketplaceDoEvento) === canal;
}

/** O canal na URL do `/diagnostico` (`?canal=`): só os dois que existem. */
export function canalDaUrl(raw: unknown): Canal | null {
  if (raw === "shopee") return "SHOPEE";
  if (raw === "ml") return "ML";

  return null;
}

export function canalParaUrl(canal: Canal): "ml" | "shopee" {
  return canal === "SHOPEE" ? "shopee" : "ml";
}
