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
 * **Não há busca aqui, e a ausência é do frame.** A variação `purchases` do
 * mesmo `ProcessScreen` traz um campo ("Buscar PC, fornecedor...") e a `nfe`
 * NÃO — o cabeçalho do painel dela tem só "Filtros ⌄". Inventar o campo seria
 * inventar; e, de quebra, uma busca multi-coluna exigiria `.or()` do PostgREST,
 * cuja sintaxe é string e aceitaria vírgula e parêntese vindos da URL.
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

/** `documents.operation_type` — a direção do movimento que a nota gera. */
export const OPERATION_TYPES = ["ENTRADA", "SAIDA"] as const;

export type OperationType = (typeof OPERATION_TYPES)[number];

export interface DocumentFilters {
  status: DocumentStatus | null;
  operation: OperationType | null;
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

export function resolveDocumentFilters(
  query: Record<string, string | string[] | undefined>,
): DocumentFilters {
  return {
    status: resolveDocumentStatus(query.estado),
    operation: resolveOperationType(query.direcao),
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
