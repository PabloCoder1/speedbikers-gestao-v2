import { buildFilterHref, resolvePageParam } from "./filters";

export const KNOWLEDGE_PAGE_SIZE = 50;
export const KNOWLEDGE_STATUSES = ["SUGERIDO", "VALIDADO", "REJEITADO", "OBSOLETO"] as const;
export const KNOWLEDGE_KINDS = ["COMPATIBILIDADE", "ESPECIFICACAO", "POLITICA", "OUTRO"] as const;
export const KNOWLEDGE_SOURCES = ["CONFIRMACAO_INTERNA", "FABRICANTE", "DOCUMENTACAO", "ATENDIMENTO"] as const;

export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];
export type KnowledgeKindFilter = (typeof KNOWLEDGE_KINDS)[number];
export type KnowledgeSourceFilter = (typeof KNOWLEDGE_SOURCES)[number];

export interface KnowledgeFilters {
  status: KnowledgeStatus | null;
  kind: KnowledgeKindFilter | null;
  source: KnowledgeSourceFilter | null;
  search: string | null;
  page: number;
}

function readParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function fromList<T extends string>(value: string | null, values: readonly T[]): T | null {
  return value !== null && values.includes(value as T) ? (value as T) : null;
}

function resolveSearch(value: string | null): string | null {
  const search = value?.trim() ?? "";
  return search === "" ? null : search.slice(0, 80);
}

export function resolveKnowledgeFilters(query: Record<string, string | string[] | undefined>): KnowledgeFilters {
  return {
    status: fromList(readParam(query.status), KNOWLEDGE_STATUSES),
    kind: fromList(readParam(query.tipo), KNOWLEDGE_KINDS),
    source: fromList(readParam(query.fonte), KNOWLEDGE_SOURCES),
    search: resolveSearch(readParam(query.busca)),
    page: resolvePageParam(readParam(query.pagina)),
  };
}

export function buildKnowledgeHref(current: KnowledgeFilters, override: Partial<KnowledgeFilters> = {}): string {
  const next = { ...current, ...override };
  return buildFilterHref("/atendimento/conhecimento", {
    status: next.status,
    tipo: next.kind,
    fonte: next.source,
    busca: next.search,
  }, override.page === undefined ? 1 : next.page);
}
