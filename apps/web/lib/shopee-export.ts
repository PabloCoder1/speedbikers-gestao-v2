/**
 * O CSV das telas da Shopee (D-490): os pedidos de `/vendas/shopee` e os
 * anúncios de `/anuncios/shopee`, no recorte da tela. A paridade com o que o ML
 * já exporta (`/anuncios/exportar`, D-385; `/full/exportar`, D-380).
 *
 * Mesmo formato (`lib/csv.ts`: `;`, vírgula decimal, BOM, CRLF e a defesa contra
 * fórmula) e as MESMAS palavras da tela — rótulo de situação, estado do vínculo,
 * status do item, origem do SKU. Ausência é célula vazia, nunca zero (D-067), e
 * código que a tela não conhece vira "outro", nunca o código cru (D-476).
 *
 * Sem dado pessoal: as RPCs não devolvem comprador nem endereço.
 */

import { csvCell, csvDocument, csvNumber } from "./csv";
import { formatDateTime } from "./format";
import { shopeeItemStatus } from "./shopee-listings";
import { lojaDeTesteShopee, origemDoSkuShopee, parseShopeeOrderItems, shopeeSituacao } from "./shopee-sales";

/** Uma linha de `get_shopee_orders`, como a tela lê. */
export interface PedidoShopeeExport {
  readonly order_sn: string;
  readonly shop_name: string | null;
  readonly environment: string;
  readonly shopee_created_at: string;
  readonly situacao: string;
  readonly order_status: string;
  readonly unidades: number | null;
  readonly receita_bruta: number | null;
  readonly recebido: number | null;
  readonly financeiro_lido: boolean;
  readonly com_devolucao: boolean;
  readonly itens: unknown;
}

const CABECALHO_PEDIDOS = [
  "Pedido",
  "Loja",
  "Ambiente",
  "Criado em",
  "Situação",
  "Status na Shopee",
  "Unidades",
  "Receita bruta",
  "Recebido",
  "Financeiro lido",
  "Devolução",
  "Itens",
];

/** "2× Nome — Variação (SKU)", um por item, separados por " | ". */
function itensDoPedido(itens: unknown): string {
  return parseShopeeOrderItems(itens)
    .map((item) => {
      const nome = item.nome ?? (item.itemId === null ? "item sem nome" : `item ${String(item.itemId)}`);
      const variacao = item.variacao === null ? "" : ` — ${item.variacao}`;
      const sku = item.sku === null ? "" : ` (${item.sku})`;

      return `${item.quantidade === null ? "?" : String(item.quantidade)}× ${nome}${variacao}${sku}`;
    })
    .join(" | ");
}

export function pedidosShopeeParaCsv(linhas: readonly PedidoShopeeExport[]): string {
  return csvDocument(
    CABECALHO_PEDIDOS,
    linhas.map((linha) => [
      csvCell(linha.order_sn),
      csvCell(linha.shop_name ?? ""),
      lojaDeTesteShopee(linha.environment) ? "Teste" : "Real",
      csvCell(formatDateTime(linha.shopee_created_at)),
      csvCell(shopeeSituacao(linha.situacao)?.rotulo ?? "Outra situação"),
      csvCell(linha.order_status),
      csvNumber(linha.unidades),
      // Receita desconhecida (o financeiro e os itens não deram o valor): vazia, nunca 0.
      csvNumber(linha.receita_bruta),
      csvNumber(linha.recebido),
      linha.financeiro_lido ? "Sim" : "Não",
      linha.com_devolucao ? "Sim" : "Não",
      csvCell(itensDoPedido(linha.itens)),
    ]),
  );
}

/** Uma linha de `get_shopee_listings`, como a tela lê. */
export interface AnuncioShopeeExport {
  readonly item_id: number;
  readonly model_id: number | null;
  readonly item_name: string | null;
  readonly model_name: string | null;
  readonly shop_name: string | null;
  readonly estado: string;
  readonly item_status: string;
  readonly sku_anuncio: string | null;
  readonly sku: string | null;
  readonly vinculo_via: string | null;
  readonly current_price: number | null;
  readonly original_price: number | null;
  readonly currency: string | null;
  readonly available_stock: number | null;
  readonly details_synced_at: string | null;
  /** D-606 (C-67): ausentes antes da migration; nulas com a loja nunca lida. */
  readonly unidades_vendidas?: number | null;
  readonly receita_bruta?: number | null;
  readonly pedidos?: number | null;
  readonly unidades_sem_receita?: number | null;
}

const CABECALHO_ANUNCIOS = [
  "Item",
  "Variação",
  "Anúncio",
  "Nome da variação",
  "Loja",
  "Vínculo",
  "Status na Shopee",
  "SKU do anúncio",
  "SKU vinculado",
  "Origem do vínculo",
  "Preço",
  "Preço original",
  "Moeda",
  "Estoque",
  "Detalhes lidos em",
  // D-606: as vendas válidas do anúncio no período da tela (C-67).
  "Unidades vendidas",
  "Faturamento",
  "Pedidos",
  "Unidades sem receita conhecida",
];

/** O estado do vínculo, no singular (a tela usa o plural nos filtros). */
const ESTADO_DO_VINCULO: Readonly<Record<string, string>> = {
  VINCULADO: "Vinculado",
  SEM_SKU_NO_ANUNCIO: "Sem SKU no anúncio",
  SKU_FORA_DO_CATALOGO: "SKU fora do catálogo",
  AGUARDANDO_LEITURA: "Aguardando leitura",
};

export function anunciosShopeeParaCsv(linhas: readonly AnuncioShopeeExport[]): string {
  return csvDocument(
    CABECALHO_ANUNCIOS,
    linhas.map((linha) => [
      csvCell(String(linha.item_id)),
      linha.model_id === null ? "" : csvCell(String(linha.model_id)),
      csvCell(linha.item_name ?? ""),
      csvCell(linha.model_name ?? ""),
      csvCell(linha.shop_name ?? ""),
      csvCell(ESTADO_DO_VINCULO[linha.estado] ?? "Outro estado"),
      csvCell(shopeeItemStatus(linha.item_status).rotulo),
      csvCell(linha.sku_anuncio ?? ""),
      csvCell(linha.sku ?? ""),
      csvCell(origemDoSkuShopee(linha.vinculo_via) ?? ""),
      // Preço e estoque não lidos (item aguardando leitura): vazios, nunca 0.
      csvNumber(linha.current_price),
      csvNumber(linha.original_price),
      csvCell(linha.currency ?? ""),
      csvNumber(linha.available_stock),
      linha.details_synced_at === null ? "" : csvCell(formatDateTime(linha.details_synced_at)),
      // Loja nunca lida: vazias, nunca 0. Receita só de itens de preço 0: vazia, e as unidades ao lado.
      csvNumber(linha.unidades_vendidas ?? null),
      csvNumber(linha.receita_bruta ?? null),
      csvNumber(linha.pedidos ?? null),
      csvNumber(linha.unidades_sem_receita ?? null),
    ]),
  );
}
