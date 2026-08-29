/**
 * Filtros e janela de `/estoque` (D-139), puros e testáveis sem React nem
 * banco — mesmo padrão de `listings-dashboard.ts` (D-138),
 * `series-alignment.ts` (D-137) e `sales-metric.ts` (D-136).
 */

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
  const rawPage = typeof query.pagina === "string" ? Number.parseInt(query.pagina, 10) : Number.NaN;

  return {
    brand: readParam(query.marca),
    category: readParam(query.categoria),
    search: readParam(query.busca),
    // Presença do parâmetro é o sinal, e só `"1"` liga. Aceitar qualquer valor
    // faria `?negativo=0` LIGAR o filtro — o oposto do que o usuário escreveu.
    onlyNegative: query.negativo === "1",
    page: Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1,
  };
}

/**
 * Preserva as outras dimensões ao trocar uma, e volta para a página 1 sempre
 * que o CONJUNTO muda — manter o offset mostraria uma página vazia que parece
 * "nenhum resultado". Mesma regra de `/anuncios` (D-138).
 */
export function buildStockHref(current: StockFilters, override: Partial<StockFilters>): string {
  const next = { ...current, ...override };
  const resetPage = override.page === undefined;
  const params = new URLSearchParams();

  if (next.brand !== null) params.set("marca", next.brand);
  if (next.category !== null) params.set("categoria", next.category);
  if (next.search !== null) params.set("busca", next.search);
  if (next.onlyNegative) params.set("negativo", "1");

  const page = resetPage ? 1 : next.page;
  if (page > 1) params.set("pagina", String(page));

  const qs = params.toString();

  return qs === "" ? "/estoque" : `/estoque?${qs}`;
}

export interface StockWindow {
  label: string;
  totalPages: number;
}

export function summarizeStockWindow(page: number, totalCount: number, rowsOnPage: number): StockWindow {
  if (totalCount === 0) {
    return { label: "Nenhum SKU no filtro atual.", totalPages: 0 };
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const formatted = new Intl.NumberFormat("pt-BR");

  if (totalPages === 1) {
    return { label: `${formatted.format(totalCount)} SKUs.`, totalPages };
  }

  const first = (page - 1) * PAGE_SIZE + 1;
  const last = first + rowsOnPage - 1;

  return {
    label: `Mostrando ${formatted.format(first)} a ${formatted.format(last)} de ${formatted.format(totalCount)} SKUs, em ordem de SKU.`,
    totalPages,
  };
}
