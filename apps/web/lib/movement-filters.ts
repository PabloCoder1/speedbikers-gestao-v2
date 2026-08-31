/**
 * Filtros de `/estoque/movimentacoes` (D-167), puros e testáveis — mesma
 * divisão de D-141: a MECÂNICA (href, página, resumo da janela) vem de
 * `./filters`; aqui vive só o vocabulário desta tela.
 *
 * `tipo`/`local`/`origem` são validados contra os conjuntos FECHADOS do
 * banco: valor desconhecido na URL cai para "sem filtro" em silêncio (não é
 * erro de rede nem de dado — mesmo tratamento de conta desconhecida em
 * `/vendas`), e nunca chega à RPC.
 */

import { buildFilterHref, resolvePageParam, summarizePagedWindow } from "./filters";

export const PAGE_SIZE = 50;

export const MOVEMENT_TYPES = [
  "ENTRADA_NFE",
  "SAIDA_NFE",
  "VENDA_ML",
  "CANCELAMENTO_ML",
  "DEVOLUCAO_ML",
  "AJUSTE_MANUAL",
  "AJUSTE_RECONCILIACAO",
  "TRANSFERENCIA",
  "RESERVA",
  "LIBERACAO_RESERVA",
  "ENTRADA_TRANSITO",
  "RECEBIMENTO_TRANSITO",
] as const;

export const LOCATION_KINDS = ["LOCAL", "RESERVADO", "TRANSITO"] as const;

export const SOURCE_TYPES = ["ORDER", "RECONCILIATION", "CLAIM", "DOCUMENT", "PURCHASE_ORDER"] as const;

export interface MovementFilters {
  search: string | null;
  movementType: string | null;
  locationKind: string | null;
  sourceType: string | null;
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

export function resolveMovementFilters(query: Record<string, string | string[] | undefined>): MovementFilters {
  return {
    search: readParam(query.busca),
    movementType: readMember(query.tipo, MOVEMENT_TYPES),
    locationKind: readMember(query.local, LOCATION_KINDS),
    sourceType: readMember(query.origem, SOURCE_TYPES),
    dateFrom: readDate(query.de),
    dateTo: readDate(query.ate),
    page: resolvePageParam(query.pagina),
  };
}

/** Preserva as outras dimensões; conjunto novo volta à página 1 (regra de D-138/D-139). */
export function buildMovementHref(current: MovementFilters, override: Partial<MovementFilters>): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/estoque/movimentacoes",
    {
      busca: next.search,
      tipo: next.movementType,
      local: next.locationKind,
      origem: next.sourceType,
      de: next.dateFrom,
      ate: next.dateTo,
    },
    override.page === undefined ? 1 : next.page,
  );
}

export { summarizePagedWindow };
