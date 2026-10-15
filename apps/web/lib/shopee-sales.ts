/**
 * Vocabulário de `/vendas/shopee` (D-430, fatia 6a da trilha Shopee).
 *
 * A VENDA SHOPEE é definida no banco (`shopee_sales_orders`,
 * `docs/METRICS.md` seção 5S) e lida por duas RPCs: `get_shopee_sales_by_shop`
 * (uma linha por loja, contadores e somas no SQL) e `get_shopee_orders` (a
 * lista paginada no SQL, com `total_count`). Aqui mora só o que é da tela: as
 * três situações, a origem do SKU gravado no item, a leitura dos itens que a
 * RPC devolve em `jsonb` e a URL. **Nada aqui soma nem conta linha** — um total
 * entre lojas, se um dia existir, nasce numa RPC (a loja de sandbox nunca entra
 * em total da empresa, e só o SQL sabe separá-la sem uma segunda lista).
 *
 * A MECÂNICA (href, página, janela) vem de `./filters`, e o período é o
 * vocabulário único do app (`./period`, D-311): "últimos 30 dias" quer dizer a
 * mesma coisa aqui e em `/vendas`, e o link entre as duas telas leva o período.
 */

import type { Tom } from "../components/tone";
import { buildFilterHref, resolvePageParam, summarizePagedWindow, type PagedWindow } from "./filters";
import { DEFAULT_PERIOD_DAYS, resolvePeriodRange, type PeriodRange } from "./period";

export const SHOPEE_SALES_PATH = "/vendas/shopee";

/** 50 pedidos por página, fixo — a RPC aceita até 200. */
export const SHOPEE_ORDERS_PAGE_SIZE = 50;

/**
 * As quatro métricas catalogadas em `metric_definitions` (migration
 * `20261014150000_vendas_shopee.sql`). O `id` é o que a tela mostra ao lado do
 * número — a rastreabilidade até a definição canônica, como a faixa de
 * `/vendas` faz —, e a `formula` vai no `title`.
 */
export const SHOPEE_SALES_METRICS = {
  pedidos: {
    id: "shopee_pedidos",
    rotulo: "Pedidos",
    formula:
      "Pedidos válidos: pagos e fora de não pago, cancelado e em cancelamento; o dia é o da criação do pedido em São Paulo.",
  },
  unidades: {
    id: "shopee_unidades",
    rotulo: "Unidades",
    formula: "Soma das quantidades dos itens dos pedidos válidos.",
  },
  receitaBruta: {
    id: "shopee_receita_bruta",
    rotulo: "Receita bruta",
    formula:
      "Produtos com o desconto da loja, sem o frete e antes dos cupons da Shopee: do financeiro quando lido; antes, preço × quantidade dos itens. Item de preço 0 (bundle) deixa a receita do pedido desconhecida, nunca zero.",
  },
  recebido: {
    id: "shopee_recebido",
    rotulo: "Recebido",
    formula:
      "O que a própria Shopee diz que a loja recebe pelo pedido (escrow), só dos pedidos válidos com o financeiro lido; provisório até o pedido completar.",
  },
} as const satisfies Record<string, { id: string; rotulo: string; formula: string }>;

/**
 * As três situações de `shopee_sales_orders.situacao`, na ordem do menu.
 * Conjunto FECHADO, espelho do `case` da view: um valor desconhecido na URL cai
 * para "todas" antes de tocar o banco, em vez de virar uma lista vazia
 * indistinguível de um filtro legítimo sem resultado.
 */
export const SHOPEE_SITUACOES = [
  {
    slug: "validas",
    codigo: "VALIDA",
    rotulo: "Válida",
    plural: "Válidas",
    criterio: "Pago, e fora de não pago, cancelado e em cancelamento — o pedido que conta nas somas.",
    tom: "ok",
  },
  {
    slug: "canceladas",
    codigo: "CANCELADA",
    rotulo: "Cancelada",
    plural: "Canceladas",
    criterio: "Cancelado ou em cancelamento na Shopee (CANCELLED, IN_CANCEL) — fora das somas.",
    tom: "perigo",
  },
  {
    slug: "nao-pagas",
    codigo: "NAO_PAGA",
    rotulo: "Não paga",
    plural: "Não pagas",
    criterio: "O comprador ainda não pagou (UNPAID, ou sem data de pagamento) — fora das somas.",
    tom: "neutro",
  },
] as const satisfies readonly {
  slug: string;
  codigo: string;
  rotulo: string;
  plural: string;
  criterio: string;
  tom: Tom;
}[];

export type ShopeeSituacao = (typeof SHOPEE_SITUACOES)[number];
export type ShopeeSituacaoSlug = ShopeeSituacao["slug"];

/** A situação pelo código do banco; `null` para um código que a tela não conhece. */
export function shopeeSituacao(codigo: string): ShopeeSituacao | null {
  return SHOPEE_SITUACOES.find((situacao) => situacao.codigo === codigo) ?? null;
}

/**
 * De onde veio o SKU gravado no item (`shopee_order_items.vinculo_via`, D-430):
 * o vínculo manual vence, depois o SKU do anúncio, e por último o SKU que veio
 * no próprio pedido — o que guarda a venda do anúncio apagado ou ainda não
 * lido. Os dois primeiros rótulos são os de `/anuncios/shopee`.
 */
const ORIGENS_DO_SKU: Record<string, string> = {
  MANUAL: "vínculo manual",
  SKU_DO_ANUNCIO: "pelo SKU do anúncio",
  SKU_DO_PEDIDO: "SKU do pedido",
};

/** O rótulo da origem; código desconhecido aparece cru, nulo é `null`. */
export function origemDoSkuShopee(vinculoVia: string | null): string | null {
  if (vinculoVia === null) return null;

  return ORIGENS_DO_SKU[vinculoVia] ?? vinculoVia;
}

/** Um item do pedido, como `get_shopee_orders` o devolve em `itens` (jsonb). */
export interface ShopeeOrderItem {
  readonly itemId: number | null;
  readonly modelId: number | null;
  readonly nome: string | null;
  readonly variacao: string | null;
  readonly quantidade: number | null;
  readonly skuId: string | null;
  readonly sku: string | null;
  readonly vinculoVia: string | null;
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor : null;
}

function numero(valor: unknown): number | null {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : null;
}

/**
 * Lê o `jsonb_agg` dos itens. Pedido sem item chega NULO (o agregado de um
 * conjunto vazio) e vira lista vazia; qualquer entrada que não seja objeto é
 * descartada, e campo de tipo inesperado vira `null` — a tela diz "—", nunca
 * inventa.
 */
export function parseShopeeOrderItems(itens: unknown): ShopeeOrderItem[] {
  if (!Array.isArray(itens)) return [];

  return itens.flatMap((bruto: unknown): ShopeeOrderItem[] => {
    if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) return [];

    const item = bruto as Record<string, unknown>;

    return [
      {
        itemId: numero(item.item_id),
        modelId: numero(item.model_id),
        nome: texto(item.nome),
        variacao: texto(item.variacao),
        quantidade: numero(item.quantidade),
        skuId: texto(item.sku_id),
        sku: texto(item.sku),
        vinculoVia: texto(item.vinculo_via),
      },
    ];
  });
}

export interface ShopeeSalesFilters {
  readonly range: PeriodRange;
  /** `null` = período personalizado (`from`/`to` na URL). */
  readonly days: number | null;
  /** `shopee_shops.id` — só um id de loja da organização sobrevive. */
  readonly loja: string | null;
  readonly situacao: ShopeeSituacaoSlug | null;
  readonly pagina: number;
  /**
   * O `order_sn` que a Busca Universal abriu (C-57, D-476): vai ao
   * `p_order_sn` da `get_shopee_orders`, que o casa sem diferenciar maiúscula.
   * Só letra, dígito e hífen, de 2 a 40 — a regra da busca no banco.
   */
  readonly pedido: string | null;
}

const PEDIDO_VALIDO = /^[A-Za-z0-9-]{2,40}$/u;

function primeiro(valor: string | string[] | undefined): string | undefined {
  return Array.isArray(valor) ? valor[0] : valor;
}

/**
 * `p_offset` é `integer` no banco: uma página digitada na URL que o estoure
 * viraria erro de "fora do intervalo". Presa aqui, ela só passa do fim — e a
 * tela diz isso.
 */
const PAGINA_MAX = Math.floor(2_147_483_647 / SHOPEE_ORDERS_PAGE_SIZE);

/**
 * O recorte pedido pela URL. O período é o de `/vendas` (`days`, ou
 * `from`/`to`), e `invalidCustom` diz quando o personalizado veio ruim e caiu no
 * padrão — para a tela avisar em vez de mostrar outra janela calada.
 */
export function resolveShopeeSalesFilters(
  query: Readonly<Record<string, string | string[] | undefined>>,
  lojasDaOrganizacao: readonly string[],
  today: string,
): { filters: ShopeeSalesFilters; invalidCustom: boolean } {
  const { range, days, invalidCustom } = resolvePeriodRange(query, today);
  const loja = primeiro(query.loja);
  const situacao = primeiro(query.situacao);
  const pedido = primeiro(query.pedido)?.trim();

  return {
    filters: {
      range,
      days,
      loja: loja !== undefined && lojasDaOrganizacao.includes(loja) ? loja : null,
      situacao: SHOPEE_SITUACOES.find((s) => s.slug === situacao)?.slug ?? null,
      pagina: Math.min(resolvePageParam(primeiro(query.pagina)), PAGINA_MAX),
      pedido: pedido !== undefined && PEDIDO_VALIDO.test(pedido) ? pedido : null,
    },
    invalidCustom,
  };
}

/**
 * A URL da tela com um recorte trocado. Trocar qualquer filtro volta à página
 * 1 — manter o offset ao mudar o CONJUNTO mostraria uma página vazia que se lê
 * como "nenhum pedido"; só a paginação passa `pagina`. O período padrão fica
 * fora da URL, como em `/vendas`.
 */
export function buildShopeeSalesHref(
  filters: ShopeeSalesFilters,
  override: {
    readonly days?: number;
    readonly loja?: string | null;
    readonly situacao?: ShopeeSituacaoSlug | null;
    readonly pagina?: number;
    readonly pedido?: string | null;
  } = {},
): string {
  const loja = override.loja === undefined ? filters.loja : override.loja;
  const situacao = override.situacao === undefined ? filters.situacao : override.situacao;
  const pedido = override.pedido === undefined ? filters.pedido : override.pedido;
  const days = override.days ?? filters.days;
  const periodo =
    days === null
      ? { from: filters.range.from, to: filters.range.to }
      : { days: days === DEFAULT_PERIOD_DAYS ? null : String(days) };

  return buildFilterHref(SHOPEE_SALES_PATH, { ...periodo, loja, situacao, pedido }, override.pagina ?? 1);
}

export function summarizeShopeeOrdersWindow(pagina: number, totalCount: number, rowsOnPage: number): PagedWindow {
  return summarizePagedWindow({
    page: pagina,
    totalCount,
    rowsOnPage,
    pageSize: SHOPEE_ORDERS_PAGE_SIZE,
    noun: { singular: "pedido", plural: "pedidos" },
    emptyLabel: "Nenhum pedido no filtro atual.",
  });
}

/** O nome da loja, ou o número dela na Shopee quando o nome ainda não foi lido. */
export function nomeDaLojaShopee(loja: { readonly shop_name: string | null; readonly shop_id: number }): string {
  return loja.shop_name ?? `Loja ${String(loja.shop_id)}`;
}

/** Loja de sandbox (`environment <> 'live'`): nunca entra em total da empresa. */
export function lojaDeTesteShopee(environment: string): boolean {
  return environment !== "live";
}
