/**
 * Filtros da Central de Preços (D-172) — mesma divisão de D-141/D-167: a
 * MECÂNICA (href, página, resumo da janela) vem de `./filters`; aqui vive só
 * o vocabulário desta tela.
 *
 * `direcao` é conjunto FECHADO, validado antes de chegar à RPC: valor
 * desconhecido na URL cai para "sem filtro" em silêncio, como em
 * Movimentações. O período é em dia civil (`de`/`ate`), convertido para
 * instante na página — o evento tem hora, o filtro do usuário não.
 */

import { buildFilterHref, resolvePageParam, summarizePagedWindow } from "./filters";

export const PAGE_SIZE = 50;

export const PRICE_DIRECTIONS = ["up", "down"] as const;

export type PriceDirection = (typeof PRICE_DIRECTIONS)[number];

/** Rótulo humano da direção — função TOTAL: valor fora do conjunto vira o cru. */
export function priceDirectionLabel(value: string): string {
  if (value === "up") return "Aumentos";
  if (value === "down") return "Reduções";

  return value;
}

export interface PriceFilters {
  search: string | null;
  direction: string | null;
  account: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  page: number;
}

function readParam(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

function readMember(raw: unknown, allowed: readonly string[]): string | null {
  const value = readParam(raw);

  return value !== null && allowed.includes(value) ? value : null;
}

function readDate(raw: unknown): string | null {
  const value = readParam(raw);

  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export function resolvePriceFilters(query: Record<string, string | string[] | undefined>): PriceFilters {
  return {
    search: readParam(query.busca),
    direction: readMember(query.direcao, PRICE_DIRECTIONS),
    // A conta NÃO é conjunto fechado aqui: os ids vêm do banco, e a página
    // descarta um id que não pertença à organização ao montar a chamada.
    account: readParam(query.conta),
    dateFrom: readDate(query.de),
    dateTo: readDate(query.ate),
    page: resolvePageParam(query.pagina),
  };
}

/** Preserva as outras dimensões; conjunto novo volta à página 1 (regra de D-138/D-139). */
export function buildPriceHref(current: PriceFilters, override: Partial<PriceFilters>): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/precos",
    {
      busca: next.search,
      direcao: next.direction,
      conta: next.account,
      de: next.dateFrom,
      ate: next.dateTo,
    },
    override.page === undefined ? 1 : next.page,
  );
}

export { summarizePagedWindow };
