/**
 * Filtros de `/reposicao` (D-147), puros e testáveis sem React nem banco.
 *
 * A MECÂNICA (href, página, resumo da janela) vive em `./filters` (D-141);
 * aqui fica só o vocabulário desta tela — `marca` e `busca`. Marca importa
 * aqui mais que em qualquer outra: a política de reposição é resolvida por
 * marca (D-144), então filtrar por NAVETEC é ver de uma vez todos os SKUs
 * que uma regra nova alcançaria.
 */

import { buildFilterHref, resolvePageParam, summarizePagedWindow } from "./filters";

/**
 * O universo real passa de 3.200 SKUs e o teto do PostgREST é 1.000: pedir
 * "tudo" nunca trouxe tudo (D-131). A janela é declarada, e a tela sempre diz
 * quanto ficou de fora.
 */
export const PAGE_SIZE = 100;

export interface ReplenishmentFilters {
  brand: string | null;
  search: string | null;
  page: number;
}

function readParam(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

export function resolveReplenishmentFilters(
  query: Record<string, string | string[] | undefined>,
): ReplenishmentFilters {
  return {
    brand: readParam(query.marca),
    search: readParam(query.busca),
    page: resolvePageParam(query.pagina),
  };
}

/**
 * Preserva as outras dimensões ao trocar uma, e volta para a página 1 sempre
 * que o CONJUNTO muda — mesma regra de `/estoque` (D-139) e `/anuncios`
 * (D-138).
 */
export function buildReplenishmentHref(
  current: ReplenishmentFilters,
  override: Partial<ReplenishmentFilters>,
): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/reposicao",
    { marca: next.brand, busca: next.search },
    override.page === undefined ? 1 : next.page,
  );
}

export interface ReplenishmentWindow {
  label: string;
  totalPages: number;
}

export function summarizeReplenishmentWindow(
  page: number,
  totalCount: number,
  rowsOnPage: number,
): ReplenishmentWindow {
  return summarizePagedWindow({
    page,
    totalCount,
    rowsOnPage,
    pageSize: PAGE_SIZE,
    noun: { singular: "SKU", plural: "SKUs" },
    trailing: ", em ordem de prioridade de compra",
    emptyLabel: "Nenhum SKU no filtro atual.",
  });
}
