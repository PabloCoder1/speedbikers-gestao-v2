/**
 * Filtros, janela e facetas da Central de Ações (`/acoes`, D23), puros e
 * testáveis sem React nem banco.
 *
 * **Os filtros moram na URL**, como em todas as telas desta frente: sem isso o
 * link para "só as de alta prioridade" não existiria e o voltar do navegador
 * não funcionaria.
 *
 * **As duas dimensões do painel do frame têm naturezas diferentes, e isso muda
 * como cada uma é validada:**
 *
 * - `severity` é **fechada** no banco (`check (severity in ('baixa','media',
 *   'alta'))`). Valor fora da lista cai em "todas" e nunca vai ao banco — pelo
 *   motivo de D-242: zero linhas seria indistinguível de um filtro legítimo sem
 *   resultado.
 * - `kind` é **texto livre** — não há `check` constraint, e o detector pode
 *   gravar um tipo novo sem tocar no schema. Aqui não há lista para validar
 *   contra, então o valor vai ao banco como veio. O que impede o "zero mudo" é
 *   outra coisa: a RPC devolve as facetas mesmo com a página vazia (a
 *   linha-sentinela), então a tela sempre consegue dizer o que a fila tem e
 *   oferecer o caminho de volta.
 */

import { buildFilterHref, resolvePageParam } from "./filters";

/**
 * Vinte e cinco por página, não os cinquenta das telas de tabela: o frame
 * desenha CARTÕES, e cada um ocupa ~6x a altura de uma linha.
 */
export const ACTIONS_PAGE_SIZE = 25;

/**
 * "Crítica" do frame não entra: `severity` tem TRÊS valores e nenhum deles é
 * crítico. As três entram, inclusive `baixa` — que hoje tem zero linhas no
 * Dev, e cujo "0" no painel é verdade medida, não ausência disfarçada (D-067).
 */
export const SEVERITY_KEYS = ["todas", "alta", "media", "baixa"] as const;

export type SeverityKey = (typeof SEVERITY_KEYS)[number];

export interface ActionFilters {
  severity: SeverityKey;
  /** `kind` livre; `null` = todos os tipos. */
  kind: string | null;
  page: number;
}

export function resolveSeverity(raw: unknown): SeverityKey {
  if (typeof raw !== "string") return "todas";

  return (SEVERITY_KEYS as readonly string[]).includes(raw) ? (raw as SeverityKey) : "todas";
}

export function resolveActionFilters(
  query: Record<string, string | string[] | undefined>,
): ActionFilters {
  return {
    severity: resolveSeverity(query.prioridade),
    kind: typeof query.tipo === "string" && query.tipo.trim() !== "" ? query.tipo.trim() : null,
    page: resolvePageParam(query.pagina),
  };
}

/**
 * Trocar um filtro volta para a página 1. Manter o offset ao mudar o CONJUNTO
 * mostraria uma página vazia que se lê como "nenhum resultado" — a regra já
 * está em `buildFilterHref`, e passar `page` explicitamente aqui é o que a
 * aciona.
 */
export function buildActionsHref(
  current: ActionFilters,
  override: Partial<ActionFilters>,
): string {
  const next = { ...current, ...override };
  const mudouRecorte =
    (override.severity !== undefined && override.severity !== current.severity) ||
    (override.kind !== undefined && override.kind !== current.kind);

  return buildFilterHref(
    "/acoes",
    {
      prioridade: next.severity === "todas" ? null : next.severity,
      tipo: next.kind,
    },
    mudouRecorte ? 1 : next.page,
  );
}

/** Argumentos nomeados da RPC. `todas`/`null` viram `null` — sem predicado. */
export function toRpcArgs(filters: ActionFilters): {
  p_limit: number;
  p_offset: number;
  p_severity: string | null;
  p_kind: string | null;
} {
  return {
    p_limit: ACTIONS_PAGE_SIZE,
    p_offset: (filters.page - 1) * ACTIONS_PAGE_SIZE,
    p_severity: filters.severity === "todas" ? null : filters.severity,
    p_kind: filters.kind,
  };
}

/**
 * A LINHA-SENTINELA.
 *
 * `get_actions_queue` faz `facetas left join base`, então uma página vazia
 * ainda devolve UMA linha — com as colunas da ação em `null` — só para carregar
 * `open_total` e as facetas. Sem ela, escolher um filtro sem resultado apagaria
 * o painel inteiro, justamente quando o operador precisa dele para voltar.
 *
 * Quem consome descarta a sentinela por `id`. É o único ponto onde esse
 * contrato aparece do lado do TypeScript, e por isso ele tem teste.
 */
export function isQueueRow<T extends { id: string | null }>(
  row: T,
): row is T & { id: string } {
  return row.id !== null;
}

/**
 * Lê uma contagem do mapa de facetas.
 *
 * Chave ausente é **zero medido**, não desconhecido: o mapa é construído por
 * `jsonb_object_agg` sobre o inbox inteiro, então um valor que não aparece é um
 * valor que não tem linha. É o oposto de D-067 — aqui a ausência É o zero, e
 * exibir "Baixa 0" é mais honesto do que esconder a linha.
 */
export function readFacet(facet: unknown, key: string): number {
  if (typeof facet !== "object" || facet === null) return 0;

  const valor = (facet as Record<string, unknown>)[key];

  return typeof valor === "number" && Number.isFinite(valor) ? valor : 0;
}

/**
 * Os tipos presentes na fila, do mais numeroso para o menos.
 *
 * A lista vem do DADO, não de uma constante: `kind` não tem `check`, e um tipo
 * novo gravado pelo detector precisa aparecer no painel sem migration. Uma
 * lista fixa aqui faria o tipo novo sumir do painel sem ninguém notar.
 */
export function facetEntries(facet: unknown): { key: string; count: number }[] {
  if (typeof facet !== "object" || facet === null) return [];

  return Object.entries(facet as Record<string, unknown>)
    .filter((entrada): entrada is [string, number] => typeof entrada[1] === "number")
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
