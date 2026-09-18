/**
 * O recorte de `/anuncios` num lugar só — a tela e o CSV (`/anuncios/exportar`)
 * leem a MESMA URL do mesmo jeito (D-385). Antes a leitura morava dentro de
 * `page.tsx`; com a exportação, um segundo leitor com regras copiadas seria o
 * começo de "a planilha não bate com a tela".
 */
import { buildFilterHref, resolvePageSize, type PageSize } from "./filters";
import {
  PAGE_SIZE,
  orderParam,
  resolveFullFilter,
  resolveLinkStateFilter,
  resolveOrder,
  resolvePage,
  resolveSoldFilter,
  resolveStatusFilter,
  resolveStockFilter,
  type ListingsOrder,
} from "./listings-dashboard";
import { DEFAULT_PERIOD_DAYS, resolvePeriodDays } from "./period";

export interface ListingsFilters {
  /** Slug da conta, ou `null` para todas. */
  account: string | null;
  status: string | null;
  link: string;
  stock: string;
  full: string;
  /** 'all' | 'with' | 'without' — venda na janela (D-308, predicado de D-259). */
  sold: string;
  /** Dias da janela. Muda venda/visitas/conversão e o predicado `sold` (D-308). */
  days: number;
  search: string | null;
  order: ListingsOrder;
  pageSize: PageSize;
  page: number;
}

type Query = Record<string, string | string[] | undefined>;

/**
 * Slug desconhecido cai em "todas as contas" em silêncio — mesmo tratamento de
 * `/vendas`, não é erro de rede nem de dado.
 */
export function resolveListingsFilters(query: Query, accountSlugs: readonly string[]): ListingsFilters {
  const conta = typeof query.conta === "string" && accountSlugs.includes(query.conta) ? query.conta : null;

  return {
    account: conta,
    status: resolveStatusFilter(query.estado),
    link: resolveLinkStateFilter(query.vinculo),
    stock: resolveStockFilter(query.estoque),
    full: resolveFullFilter(query.full),
    sold: resolveSoldFilter(query.venda),
    days: resolvePeriodDays(query.dias),
    search: typeof query.busca === "string" && query.busca.trim() !== "" ? query.busca.trim() : null,
    order: resolveOrder(query.ordem),
    pageSize: resolvePageSize(query.tamanho, PAGE_SIZE),
    page: resolvePage(query.pagina),
  };
}

/** Os parâmetros da URL do recorte — sem a página, que só a tela tem. */
export function listingsParams(filters: ListingsFilters): Record<string, string | null> {
  return {
    conta: filters.account,
    estado: filters.status,
    // "all" é o padrão de cada eixo: fica fora da URL.
    vinculo: filters.link === "all" ? null : filters.link,
    estoque: filters.stock === "all" ? null : filters.stock,
    full: filters.full === "all" ? null : filters.full,
    venda: filters.sold === "all" ? null : filters.sold,
    // `/anuncios` continua sendo o endereço da janela de 30 dias, por
    // faturamento, 50 por página.
    dias: filters.days === DEFAULT_PERIOD_DAYS ? null : String(filters.days),
    busca: filters.search,
    ordem: orderParam(filters.order),
    tamanho: filters.pageSize === PAGE_SIZE ? null : String(filters.pageSize),
  };
}

/**
 * Preserva as outras dimensões ao trocar uma. Qualquer mudança de filtro,
 * ordem ou tamanho volta para a página 1: manter o offset seria mostrar
 * "página 7 de 2", ou uma página vazia que parece "nenhum resultado".
 */
export function buildListingsHref(current: ListingsFilters, override: Partial<ListingsFilters>): string {
  const next = { ...current, ...override };

  return buildFilterHref("/anuncios", listingsParams(next), override.page === undefined ? 1 : next.page);
}

/** O recorte sem nenhum filtro de estado — conta, período, ordem e tamanho ficam. */
export const NEUTRO: Partial<ListingsFilters> = {
  status: null,
  link: "all",
  stock: "all",
  full: "all",
  sold: "all",
  search: null,
};

/*
  VISÕES RÁPIDAS (D-385). As perguntas que o catálogo faz todo dia, cada uma
  uma COMBINAÇÃO de filtros que a tela já tem — nenhuma métrica nova, nenhum
  limiar inventado: "vendendo sem estoque" é `estoque = 0` E `vendeu no
  período`, exatamente o que dá para montar à mão em dois menus.
*/
export interface QuickView {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly filters: Partial<ListingsFilters>;
}

export const QUICK_VIEWS: readonly QuickView[] = [
  {
    key: "zerado-vendendo",
    label: "Vendendo sem estoque",
    hint: "Estoque do anúncio zerado e venda no período — venda que está parando agora.",
    filters: { stock: "out", sold: "with" },
  },
  {
    key: "pausado-vendendo",
    label: "Pausados que venderam",
    hint: "Pausados hoje, com venda no período.",
    filters: { status: "paused", sold: "with" },
  },
  {
    key: "ativo-sem-venda",
    label: "Ativos sem venda",
    hint: "Ativos e sem nenhuma venda no período.",
    filters: { status: "active", sold: "without" },
  },
  {
    key: "sem-vinculo-vendendo",
    label: "Sem vínculo com venda",
    hint: "Vendem, mas não baixam estoque de SKU nenhum — prioridade da Central de Vinculações.",
    filters: { link: "unlinked", sold: "with" },
  },
];

const EIXOS = ["status", "link", "stock", "full", "sold", "search"] as const;

/** A visão está ativa quando os eixos de estado são EXATAMENTE os dela. */
export function isQuickViewActive(view: QuickView, filters: ListingsFilters): boolean {
  const alvo = { ...(NEUTRO as ListingsFilters), ...view.filters };

  return EIXOS.every((eixo) => filters[eixo] === alvo[eixo]);
}

/** Clicar na visão ativa desfaz; clicar numa outra troca o recorte inteiro de estado. */
export function quickViewHref(view: QuickView, filters: ListingsFilters): string {
  return isQuickViewActive(view, filters)
    ? buildListingsHref(filters, NEUTRO)
    : buildListingsHref(filters, { ...NEUTRO, ...view.filters });
}

/**
 * A conversão do RECORTE: pedidos dos dias com visita ÷ visitas, somados no SQL
 * (D-170) — nunca a média das taxas das linhas. Sem visita, indefinida.
 */
export function recorteConversion(pedidos: number | null | undefined, visitas: number | null | undefined): number | null {
  if (pedidos === null || pedidos === undefined || visitas === null || visitas === undefined || visitas <= 0) {
    return null;
  }

  return pedidos / visitas;
}

/** Participação da linha no faturamento do recorte, de 0 a 1; indefinida sem faturamento. */
export function revenueShare(linha: number, recorte: number | null | undefined): number | null {
  if (recorte === null || recorte === undefined || recorte <= 0) return null;

  return Math.min(Math.max(linha / recorte, 0), 1);
}
