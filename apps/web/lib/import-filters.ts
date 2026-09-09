/**
 * Filtros e janela das duas telas de importação (D-278, fatia D37b).
 *
 * A LISTA (`/importacoes`) não tinha filtro nem janela: lia `.limit(50)` sem
 * `count`, e com 51 lotes o 51º não existia para quem olhava — a mesma classe
 * de D-131 que D-253 corrigiu em `/notas-fiscais`. As duas dimensões vêm dos
 * conjuntos fechados do banco (`erp_import_batches_kind_check` e
 * `erp_import_batches_status_check`), pelo mesmo motivo de lá: sobre conjunto
 * fechado o resolvedor consegue RECUSAR valor adulterado na URL.
 *
 * O DETALHE (`/importacoes/[id]`) já tinha filtro e paginação, mas com um
 * `href()` local reimplementando `buildFilterHref` e pílulas de raio 999px —
 * a forma que o design system substituiu por `FilterPill`. Aqui fica a
 * mecânica; a forma vai na tela.
 */
import { buildFilterHref, resolvePageParam, summarizePagedWindow } from "./filters";

/** Lotes por página na lista. */
export const BATCH_PAGE_SIZE = 50;

/** Linhas por página na conferência — o tamanho que a tela já usava. */
export const ROW_PAGE_SIZE = 100;

/** `erp_import_batches_kind_check`. */
export const IMPORT_KINDS = ["PRODUCTS", "KITS", "LINKS", "STOCK"] as const;

/** `erp_import_batches_status_check`. */
export const IMPORT_STATUSES = [
  "UPLOADED",
  "PARSING",
  "PARSED",
  "APPLYING",
  "APPLIED",
  "FAILED",
  "CANCELLED",
] as const;

/** `erp_import_rows_status_check`. */
export const ROW_STATUSES = ["OK", "SKIPPED", "INVALID"] as const;

function readMember(raw: unknown, allowed: readonly string[]): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";

  return value !== "" && allowed.includes(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Lista de lotes
// ---------------------------------------------------------------------------

export interface ImportFilters {
  kind: string | null;
  status: string | null;
  page: number;
}

export function resolveImportFilters(query: Record<string, string | string[] | undefined>): ImportFilters {
  return {
    kind: readMember(query.tipo, IMPORT_KINDS),
    status: readMember(query.estado, IMPORT_STATUSES),
    page: resolvePageParam(query.pagina),
  };
}

export function buildImportHref(current: ImportFilters, patch: Partial<ImportFilters>): string {
  const next = { ...current, ...patch };

  return buildFilterHref(
    "/importacoes",
    { tipo: next.kind, estado: next.status },
    // Trocar de recorte volta à página 1: manter o offset mostraria uma janela
    // vazia, que se lê como "nenhum lote".
    patch.page ?? (patch.kind !== undefined || patch.status !== undefined ? 1 : current.page),
  );
}

export function summarizeBatchWindow(
  page: number,
  totalCount: number,
  rowsOnPage: number,
): { label: string; totalPages: number } {
  return summarizePagedWindow({
    page,
    totalCount,
    rowsOnPage,
    pageSize: BATCH_PAGE_SIZE,
    noun: { singular: "importação", plural: "importações" },
    emptyLabel: "Nenhuma importação com estes filtros.",
    trailing: ", da mais recente para a mais antiga",
  });
}

// ---------------------------------------------------------------------------
// Conferência de um lote
// ---------------------------------------------------------------------------

export interface RowFilters {
  status: string | null;
  page: number;
}

export function resolveRowFilters(query: Record<string, string | string[] | undefined>): RowFilters {
  return {
    status: readMember(query.status, ROW_STATUSES),
    page: resolvePageParam(query.pagina),
  };
}

export function buildRowHref(batchId: string, current: RowFilters, patch: Partial<RowFilters>): string {
  const next = { ...current, ...patch };

  return buildFilterHref(
    `/importacoes/${batchId}`,
    { status: next.status },
    patch.page ?? (patch.status !== undefined ? 1 : current.page),
  );
}

export function summarizeRowWindow(
  page: number,
  totalCount: number,
  rowsOnPage: number,
): { label: string; totalPages: number } {
  return summarizePagedWindow({
    page,
    totalCount,
    rowsOnPage,
    pageSize: ROW_PAGE_SIZE,
    noun: { singular: "linha", plural: "linhas" },
    emptyLabel: "Nenhuma linha neste filtro.",
    // A ordem é conteúdo aqui: quem confere está com a planilha aberta ao lado,
    // e a linha 4.312 desta tabela tem de ser a 4.312 de lá.
    trailing: ", na ordem da planilha",
  });
}
