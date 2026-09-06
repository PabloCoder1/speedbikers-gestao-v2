/**
 * Filtros de `/compras` (D19 da frente visual), puros e testáveis sem React
 * nem banco.
 *
 * A mecânica compartilhada (href, página, janela) vive em `./filters` desde
 * D-141; aqui fica o vocabulário próprio: estado do pedido e busca.
 *
 * **Cinco estados, não os sete do brief.** O brief §23 pede também "Em
 * trânsito" e "Recebido parcialmente", e o frame desenha um badge
 * "Recebimento Parcial" — mas a `check` constraint de `purchase_orders` aceita
 * exatamente `DRAFT/APPROVED/ORDERED/RECEIVED/CANCELLED`. Não é lacuna de
 * tela: é o esquema recusando. Recebimento parcial exigiria quantidade
 * RECEBIDA por item, que `purchase_order_items` não tem.
 *
 * **A busca existe porque o frame a tem** — ao contrário da variação `nfe`
 * (D-253), a `purchases` traz o campo "Buscar PC, fornecedor…". Ela vai para a
 * RPC como argumento, não para um `.or()` do PostgREST: argumento é
 * parametrizado, e a sintaxe do `.or()` é uma string com vírgula e parêntese
 * como separadores.
 */

import { buildFilterHref, resolvePageParam, summarizePagedWindow } from "./filters";

export const PAGE_SIZE = 50;

/** `purchase_orders.status` — ciclo DRAFT→APPROVED→ORDERED→RECEIVED, com CANCELLED de qualquer estado não terminal. */
export const PURCHASE_ORDER_STATUSES = [
  "DRAFT",
  "APPROVED",
  "ORDERED",
  "RECEIVED",
  "CANCELLED",
] as const;

export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export interface PurchaseOrderFilters {
  status: PurchaseOrderStatus | null;
  search: string | null;
  page: number;
}

/** Mesma leitura de `abc-filters`: vazio e só-espaço viram nulo. */
function readParam(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/**
 * Estado fora da lista fechada cai em "todos" e NÃO vai ao banco: zero linhas
 * seria indistinguível de um filtro legítimo sem resultado (lição de D-242).
 */
export function resolvePurchaseOrderStatus(raw: unknown): PurchaseOrderStatus | null {
  if (typeof raw !== "string") return null;

  return (PURCHASE_ORDER_STATUSES as readonly string[]).includes(raw)
    ? (raw as PurchaseOrderStatus)
    : null;
}

export function resolvePurchaseOrderFilters(
  query: Record<string, string | string[] | undefined>,
): PurchaseOrderFilters {
  return {
    status: resolvePurchaseOrderStatus(query.estado),
    search: readParam(query.busca),
    page: resolvePageParam(query.pagina),
  };
}

export function buildPurchaseOrderHref(
  current: PurchaseOrderFilters,
  override: Partial<PurchaseOrderFilters>,
): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/compras",
    {
      // "Todos" é a ausência do parâmetro: `/compras` limpo continua sendo a
      // mesma página de sempre.
      estado: next.status,
      busca: next.search,
    },
    override.page === undefined ? 1 : next.page,
  );
}

/**
 * A frase que impede o defeito que a tela tinha: ela lia `.limit(100)` e o
 * rodapé dizia "{data.length} pedido(s)" — com 100 pedidos ou mais, isso
 * AFIRMAVA um total que era só o tamanho da página (D-131). E "pedido(s)" era
 * a flexão que `summarizePagedWindow` existe para resolver.
 */
export function summarizePurchaseOrderWindow(
  page: number,
  totalCount: number,
  rowsOnPage: number,
): { label: string; totalPages: number } {
  return summarizePagedWindow({
    page,
    totalCount,
    rowsOnPage,
    pageSize: PAGE_SIZE,
    noun: { singular: "pedido", plural: "pedidos" },
    emptyLabel: "Nenhum pedido de compra com estes filtros.",
  });
}
