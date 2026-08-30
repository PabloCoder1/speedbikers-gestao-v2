/**
 * Filtros de `/estoque` (D-139), puros e testáveis sem React nem banco.
 *
 * A MECÂNICA (href, página, resumo da janela) vive em `./filters` desde D-141;
 * aqui fica só o vocabulário desta tela — `marca`, `categoria`, `negativo` —,
 * que é justamente o que não se generaliza sem virar um resolvedor que aceita
 * qualquer coisa.
 */

import { buildFilterHref, resolvePageParam, summarizePagedWindow } from "./filters";

/**
 * O conjunto real passa de 3.100 SKUs e o teto do PostgREST é 1.000: pedir
 * "tudo" nunca trouxe tudo (D-131). A janela é declarada, e a tela sempre diz
 * quanto ficou de fora.
 */
export const PAGE_SIZE = 100;

export interface StockFilters {
  brand: string | null;
  category: string | null;
  search: string | null;
  onlyNegative: boolean;
  page: number;
}

function readParam(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

export function resolveStockFilters(query: Record<string, string | string[] | undefined>): StockFilters {
  return {
    brand: readParam(query.marca),
    category: readParam(query.categoria),
    search: readParam(query.busca),
    // Presença do parâmetro é o sinal, e só `"1"` liga. Aceitar qualquer valor
    // faria `?negativo=0` LIGAR o filtro — o oposto do que o usuário escreveu.
    onlyNegative: query.negativo === "1",
    page: resolvePageParam(query.pagina),
  };
}

/**
 * Preserva as outras dimensões ao trocar uma, e volta para a página 1 sempre
 * que o CONJUNTO muda — manter o offset mostraria uma página vazia que parece
 * "nenhum resultado". Mesma regra de `/anuncios` (D-138).
 */
export function buildStockHref(current: StockFilters, override: Partial<StockFilters>): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/estoque",
    {
      marca: next.brand,
      categoria: next.category,
      busca: next.search,
      negativo: next.onlyNegative ? "1" : null,
    },
    override.page === undefined ? 1 : next.page,
  );
}

export interface StockWindow {
  label: string;
  totalPages: number;
}

export function summarizeStockWindow(page: number, totalCount: number, rowsOnPage: number): StockWindow {
  return summarizePagedWindow({
    page,
    totalCount,
    rowsOnPage,
    pageSize: PAGE_SIZE,
    noun: "SKUs",
    trailing: ", em ordem de SKU",
    emptyLabel: "Nenhum SKU no filtro atual.",
  });
}
