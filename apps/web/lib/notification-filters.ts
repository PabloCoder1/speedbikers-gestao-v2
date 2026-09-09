/**
 * Filtros da Central de Notificações (D-290) — mesma divisão de D-141/D-172/
 * D-289: a MECÂNICA (href, página, resumo da janela) vem de `./filters`; aqui
 * mora só o vocabulário desta tela, que é curto de propósito.
 *
 * **Duas dimensões, e nenhuma a mais.** D-269 recusou o "Filtrar" do frame por
 * ser funcionalidade e deixou UMA candidata registrada com número: com **8.350
 * não lidas de 42.511**, um recorte "só não lidas" seria útil de verdade.
 * Severidade, tipo de evento e conta continuam FORA — ninguém os pediu e
 * nenhum número os sustenta; inventar cinco filtros porque o cabeçalho do
 * desenho tem um botão é o que aquela recusa evitou.
 */

import { buildFilterHref, resolvePageParam, summarizePagedWindow } from "./filters";

/**
 * Cem por página — o mesmo teto que a tela já carregava antes de paginar
 * (D-183/D-269). A fatia acrescenta as páginas 2 em diante; a primeira
 * continua sendo a mesma.
 */
export const PAGE_SIZE = 100;

/** `todas` é o default, e default fica FORA da URL. */
export type NotificationState = "todas" | "nao-lidas";

export interface NotificationFilters {
  state: NotificationState;
  page: number;
}

function readParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;

  return value ?? null;
}

export function resolveNotificationFilters(
  query: Record<string, string | string[] | undefined>,
): NotificationFilters {
  return {
    state: readParam(query.estado) === "nao-lidas" ? "nao-lidas" : "todas",
    page: resolvePageParam(query.pagina),
  };
}

/**
 * Preserva a outra dimensão ao trocar uma, e **trocar o recorte volta à página
 * 1** (D-138/D-139): ir de "todas" na página 7 para "não lidas" mantendo o
 * offset mostraria uma página vazia que se lê como "não há não lidas".
 *
 * Quem quer a página preservada pede por escrito (`{ page: filtros.page }`).
 */
export function buildNotificationHref(
  current: NotificationFilters,
  override: Partial<NotificationFilters>,
): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/notificacoes",
    { estado: next.state === "todas" ? null : next.state },
    override.page === undefined ? 1 : next.page,
  );
}

export { summarizePagedWindow };
