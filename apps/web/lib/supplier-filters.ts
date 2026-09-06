/**
 * Filtros de `/fornecedores` (D20 da frente visual), puros e testáveis sem
 * React nem banco.
 *
 * A mecânica compartilhada (href, página, janela) vive em `./filters` desde
 * D-141; aqui fica o vocabulário próprio, que é curto de propósito: o frame
 * `ProcessScreen type="suppliers"` é o MESMO esboço da `nfe` (D-253) —
 * cabeçalho, painel "Base de Fornecedores" e um "Filtros ⌄", sem tabela
 * desenhada e sem campo de busca.
 *
 * **A única dimensão é `is_active`**, que já é coluna exibida. As outras que o
 * brief §24 pede — origem, marcas, lead time, cobertura alvo, política de
 * reposição — não existem POR FORNECEDOR e não viram filtro: `skus.supplier_id`
 * não existe de propósito (D-174) e `replenishment_settings` é escopada por
 * organização, marca (texto) ou SKU, nunca por fornecedor.
 */

import { buildFilterHref, resolvePageParam, summarizePagedWindow } from "./filters";

export const PAGE_SIZE = 50;

/** `todos` é o default: a tela sempre listou ativos e inativos juntos, e o inativo continua sendo informação. */
export const SUPPLIER_STATES = ["todos", "ativos", "inativos"] as const;

export type SupplierState = (typeof SUPPLIER_STATES)[number];

export interface SupplierFilters {
  state: SupplierState;
  page: number;
}

export function resolveSupplierState(raw: unknown): SupplierState {
  if (typeof raw !== "string") return "todos";

  return (SUPPLIER_STATES as readonly string[]).includes(raw) ? (raw as SupplierState) : "todos";
}

export function resolveSupplierFilters(
  query: Record<string, string | string[] | undefined>,
): SupplierFilters {
  return {
    state: resolveSupplierState(query.estado),
    page: resolvePageParam(query.pagina),
  };
}

export function buildSupplierHref(
  current: SupplierFilters,
  override: Partial<SupplierFilters>,
): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/fornecedores",
    { estado: next.state === "todos" ? null : next.state },
    override.page === undefined ? 1 : next.page,
  );
}

/**
 * A tela lia `.limit(200)` e não dizia nada — sem total, sem página seguinte.
 * Menos visível que o `{data.length} pedido(s)` de `/compras` (D-255), porque
 * ali havia um número ERRADO e aqui há um número AUSENTE; a classe é a mesma
 * (D-131) e a correção também.
 */
export function summarizeSupplierWindow(
  page: number,
  totalCount: number,
  rowsOnPage: number,
): { label: string; totalPages: number } {
  return summarizePagedWindow({
    page,
    totalCount,
    rowsOnPage,
    pageSize: PAGE_SIZE,
    noun: { singular: "fornecedor", plural: "fornecedores" },
    emptyLabel: "Nenhum fornecedor com estes filtros.",
  });
}
