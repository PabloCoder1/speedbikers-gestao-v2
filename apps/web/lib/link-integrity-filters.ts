/**
 * Filtros da Integridade de Catálogo (`/vinculacoes`, D21), puros e testáveis
 * sem React nem banco.
 *
 * A mecânica compartilhada (href, página, janela) vive em `./filters` desde
 * D-141; aqui fica o vocabulário próprio: estado do vínculo e venda na janela.
 *
 * **O estado NÃO é `sku_id is null`** (D-122). `link_state` tem três valores no
 * banco — `linked`, `linked_variation` e `unlinked` — e o vínculo por VARIAÇÃO
 * tem `sku_id` nulo mesmo estando ligado. Medido no Dev: 1.013 dos 1.876
 * anúncios com `sku_id` nulo são vínculo por variação, então tratar nulo como
 * "sem vínculo" **dobraria** o número (863 viraria 1.876).
 */

import { buildFilterHref, resolvePageParam, summarizePagedWindow } from "./filters";

export const PAGE_SIZE = 50;

/** O que a RPC aceita em `p_link_state`. `todos` é a ausência do filtro. */
export const LINK_STATES = ["todos", "vinculados", "sem-vinculo"] as const;

export type LinkStateKey = (typeof LINK_STATES)[number];

/** `p_sold` — houve venda na janela. Existe desde D-259, para a célula "Vendidos sem vínculo". */
export const SOLD_STATES = ["todos", "vendeu", "nao-vendeu"] as const;

export type SoldKey = (typeof SOLD_STATES)[number];

export interface LinkIntegrityFilters {
  state: LinkStateKey;
  sold: SoldKey;
  accountSlug: string | null;
  search: string | null;
  page: number;
}

function readParam(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

function resolveFromList<T extends string>(lista: readonly [T, ...T[]], raw: unknown): T {
  if (typeof raw !== "string") return lista[0];

  return (lista as readonly string[]).includes(raw) ? (raw as T) : lista[0];
}

export const resolveLinkState = (raw: unknown): LinkStateKey => resolveFromList(LINK_STATES, raw);
export const resolveSold = (raw: unknown): SoldKey => resolveFromList(SOLD_STATES, raw);

export function resolveLinkIntegrityFilters(
  query: Record<string, string | string[] | undefined>,
): LinkIntegrityFilters {
  return {
    state: resolveLinkState(query.estado),
    sold: resolveSold(query.venda),
    accountSlug: readParam(query.conta),
    search: readParam(query.busca),
    page: resolvePageParam(query.pagina),
  };
}

export function buildLinkIntegrityHref(
  current: LinkIntegrityFilters,
  override: Partial<LinkIntegrityFilters>,
): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/vinculacoes",
    {
      // Os defaults ficam FORA da URL: `/vinculacoes` limpo continua sendo a
      // mesma página de sempre.
      estado: next.state === "todos" ? null : next.state,
      venda: next.sold === "todos" ? null : next.sold,
      conta: next.accountSlug,
      busca: next.search,
    },
    override.page === undefined ? 1 : next.page,
  );
}

/**
 * Href que pré-preenche a vinculação manual a partir de uma linha da tabela
 * (D-122, restaurado em D-313).
 *
 * A conta viaja como SLUG, e não como id: é o mesmo `conta` do filtro, então o
 * link faz as duas coisas de uma vez — recorta a tabela naquela conta e diz ao
 * formulário qual conta escolher. Um id cru na URL abriria um segundo
 * vocabulário para a mesma dimensão.
 *
 * O `#` é o que faz o clique TERMINAR em algum lugar: sem ele a página recarrega
 * no topo e o formulário preenchido fica fora da tela.
 */
export function buildManualLinkHref(
  current: LinkIntegrityFilters,
  target: { accountSlug: string | null; itemId: string },
): string {
  const href = buildFilterHref(
    "/vinculacoes",
    {
      estado: current.state === "todos" ? null : current.state,
      venda: current.sold === "todos" ? null : current.sold,
      conta: target.accountSlug,
      busca: current.search,
      item: target.itemId,
    },
    // Página 1 pela mesma regra de `buildFilterHref`: o link ACRESCENTA o
    // recorte de conta, e manter o offset mostraria uma página vazia.
    1,
  );

  return `${href}#vincular-a-mao`;
}

/** Tradução para os argumentos da RPC — o único lugar que conhece os dois vocabulários. */
export function toRpcArgs(filters: LinkIntegrityFilters): {
  p_link_state: string;
  p_sold: string;
} {
  return {
    p_link_state:
      filters.state === "vinculados" ? "linked" : filters.state === "sem-vinculo" ? "unlinked" : "all",
    p_sold: filters.sold === "vendeu" ? "with" : filters.sold === "nao-vendeu" ? "without" : "all",
  };
}

export function summarizeLinkIntegrityWindow(
  page: number,
  totalCount: number,
  rowsOnPage: number,
): { label: string; totalPages: number } {
  return summarizePagedWindow({
    page,
    totalCount,
    rowsOnPage,
    pageSize: PAGE_SIZE,
    noun: { singular: "anúncio", plural: "anúncios" },
    emptyLabel: "Nenhum anúncio com estes filtros.",
  });
}
