/**
 * Filtros de `/notas-fiscais` (D18 da frente visual), puros e testáveis sem
 * React nem banco.
 *
 * A mecânica compartilhada (href, página, janela) vive em `./filters` desde
 * D-141; aqui fica o vocabulário próprio: estado do documento e direção da
 * operação.
 *
 * **As duas dimensões são as duas COLUNAS que a tabela já mostra.** O frame
 * `ProcessScreen type="nfe"` traz um controle "Filtros ⌄" sem dizer o que ele
 * recorta; o que decide são os dados reais — `documents.status` e
 * `documents.operation_type` já são colunas exibidas, e filtrar por elas faz a
 * barra prometer só o que a tabela cumpre.
 *
 * **A busca existe desde D-375**, e o que a destravou foi o banco, não o
 * desenho: `get_documents_overview` recebe `p_search` e faz o `ilike` dentro do
 * SQL. Antes dela, buscar em várias colunas exigiria `.or()` do PostgREST —
 * sintaxe em string, que aceitaria vírgula e parêntese vindos da URL.
 *
 * A terceira dimensão, também de D-375, é o TIPO do documento: a tela deixou de
 * receber só XML de NF-e e agora recebe DANFE, pedido de saída e envio ao Full.
 */

import { buildFilterHref, resolvePageParam, summarizePagedWindow } from "./filters";

/**
 * A página lia 50 com `.limit(50)` e NÃO dizia que havia corte — a classe de
 * defeito de D-131 (lista silenciosamente truncada). O tamanho continua 50; o
 * que muda é que agora existe total, janela declarada e página seguinte.
 */
export const PAGE_SIZE = 50;

/**
 * `documents.status` — o ciclo de `docs/NFE.md`:
 * `UPLOADED -> PARSING -> PARSED -> APPLYING -> APPLIED`, com `FAILED` e
 * `CANCELLED` saindo de qualquer estado não terminal.
 *
 * A lista é FECHADA de propósito: valor fora dela cai em "todos", nunca vai ao
 * banco. Um estado inventado na URL devolveria zero linhas, e zero linhas é
 * indistinguível de filtro legítimo sem resultado (lição de D-242).
 */
export const DOCUMENT_STATUSES = [
  "UPLOADED",
  "PARSING",
  "PARSED",
  "APPLYING",
  "APPLIED",
  "FAILED",
  "CANCELLED",
] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/**
 * `documents.document_type` — o layout lido (D-375).
 *
 * `NFE` é o XML; os outros três são PDF. A lista é FECHADA pelo mesmo motivo
 * dos estados: tipo inventado na URL cai em "todos", nunca vai ao banco.
 */
export const DOCUMENT_TYPES = ["NFE", "DANFE_PDF", "SAIDA_UPSELLER_PDF", "ENVIO_FULL_ML_PDF"] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** O nome curto de cada layout, do jeito que a operação chama. */
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  NFE: "NF-e (XML)",
  DANFE_PDF: "DANFE (PDF)",
  SAIDA_UPSELLER_PDF: "Pedido de saída",
  ENVIO_FULL_ML_PDF: "Envio ao Full",
};

export function documentTypeLabel(raw: string | null): string {
  if (raw === null) return "Em leitura";

  return (DOCUMENT_TYPE_LABELS as Record<string, string>)[raw] ?? raw;
}

/** `documents.operation_type` — a direção do movimento que a nota gera. */
export const OPERATION_TYPES = ["ENTRADA", "SAIDA"] as const;

export type OperationType = (typeof OPERATION_TYPES)[number];

export interface DocumentFilters {
  status: DocumentStatus | null;
  operation: OperationType | null;
  type: DocumentType | null;
  search: string | null;
  page: number;
}

export function resolveDocumentStatus(raw: unknown): DocumentStatus | null {
  if (typeof raw !== "string") return null;

  return (DOCUMENT_STATUSES as readonly string[]).includes(raw) ? (raw as DocumentStatus) : null;
}

export function resolveOperationType(raw: unknown): OperationType | null {
  if (typeof raw !== "string") return null;

  return (OPERATION_TYPES as readonly string[]).includes(raw) ? (raw as OperationType) : null;
}

/** Mesma leitura de `purchase-order-filters`: vazio e só-espaço viram nulo. */
function lerBusca(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

export function resolveDocumentType(raw: unknown): DocumentType | null {
  if (typeof raw !== "string") return null;

  return (DOCUMENT_TYPES as readonly string[]).includes(raw) ? (raw as DocumentType) : null;
}

export function resolveDocumentFilters(
  query: Record<string, string | string[] | undefined>,
): DocumentFilters {
  return {
    status: resolveDocumentStatus(query.estado),
    operation: resolveOperationType(query.direcao),
    type: resolveDocumentType(query.tipo),
    search: lerBusca(query.busca),
    page: resolvePageParam(query.pagina),
  };
}

export function buildDocumentHref(
  current: DocumentFilters,
  override: Partial<DocumentFilters>,
): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/notas-fiscais",
    {
      // "Todos" é a ausência do parâmetro: `/notas-fiscais` limpo continua
      // sendo a mesma página de sempre.
      estado: next.status,
      direcao: next.operation,
      tipo: next.type,
      busca: next.search,
    },
    override.page === undefined ? 1 : next.page,
  );
}

export function summarizeDocumentWindow(
  page: number,
  totalCount: number,
  rowsOnPage: number,
): { label: string; totalPages: number } {
  return summarizePagedWindow({
    page,
    totalCount,
    rowsOnPage,
    pageSize: PAGE_SIZE,
    noun: { singular: "nota", plural: "notas" },
    emptyLabel: "Nenhuma nota fiscal com estes filtros.",
  });
}
