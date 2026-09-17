/**
 * Filtros de `/fornecedores` (D20 da frente visual, ampliados em D-366), puros
 * e testáveis sem React nem banco.
 *
 * A mecânica compartilhada (href, página, janela) vive em `./filters` desde
 * D-141; aqui fica o vocabulário próprio.
 *
 * **D-366: busca, dois recortes novos e a ordem.** Os recortes continuam sendo
 * fato de fornecedor que o banco TEM: `is_active` e os pedidos de compra. "Com
 * pedido em aberto" e "sem pedido" saem de `purchase_orders`. As dimensões do
 * brief §24 que o modelo não tem — origem, marcas, lead time, cobertura alvo,
 * política de reposição — continuam fora: `skus.supplier_id` não existe de
 * propósito (D-174) e `replenishment_settings` é escopada por organização,
 * marca (texto) ou SKU, nunca por fornecedor.
 */

import { buildFilterHref, resolvePageParam, summarizePagedWindow } from "./filters";

export const PAGE_SIZE = 50;

/** `todos` é o default: a tela sempre listou ativos e inativos juntos, e o inativo continua sendo informação. */
export const SUPPLIER_STATES = ["todos", "ativos", "em_aberto", "sem_pedido", "inativos"] as const;

export type SupplierState = (typeof SUPPLIER_STATES)[number];

/** `nome` é o default: é a ordem em que se procura um cadastro. */
export const SUPPLIER_ORDERS = ["nome", "em_aberto", "recente", "valor"] as const;

export type SupplierOrder = (typeof SUPPLIER_ORDERS)[number];

export interface SupplierFilters {
  state: SupplierState;
  order: SupplierOrder;
  search: string | null;
  page: number;
}

/** O texto da busca tem teto: a URL é entrada de terceiro e vira `ilike` no banco. */
const SEARCH_MAX = 80;

function resolveFrom<T extends string>(lista: readonly T[], raw: unknown, padrao: T): T {
  if (typeof raw !== "string") return padrao;

  return (lista as readonly string[]).includes(raw) ? (raw as T) : padrao;
}

export function resolveSupplierState(raw: unknown): SupplierState {
  return resolveFrom(SUPPLIER_STATES, raw, "todos");
}

export function resolveSupplierOrder(raw: unknown): SupplierOrder {
  return resolveFrom(SUPPLIER_ORDERS, raw, "nome");
}

export function resolveSupplierSearch(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const termo = raw.trim().slice(0, SEARCH_MAX);

  return termo === "" ? null : termo;
}

export function resolveSupplierFilters(query: Record<string, string | string[] | undefined>): SupplierFilters {
  return {
    state: resolveSupplierState(query.estado),
    order: resolveSupplierOrder(query.ordem),
    search: resolveSupplierSearch(query.busca),
    page: resolvePageParam(query.pagina),
  };
}

export function buildSupplierHref(current: SupplierFilters, override: Partial<SupplierFilters>): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/fornecedores",
    {
      busca: next.search,
      estado: next.state === "todos" ? null : next.state,
      ordem: next.order === "nome" ? null : next.order,
    },
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
