/**
 * Regras puras do Dashboard de Anúncios (D-138) — vocabulário de filtro desta
 * tela e os rótulos de estado de vínculo.
 *
 * Mora em `lib/` para ser testável sem React nem banco. A mecânica de href,
 * página e janela vive em `./filters` desde D-141.
 */

import { resolvePageParam, summarizePagedWindow } from "./filters";

/** Tamanho da janela lida do Postgres. A tela NUNCA lê a tabela inteira (D-138). */
export const PAGE_SIZE = 50;

export const LINK_STATE_FILTERS = [
  { key: "all", label: "Todos" },
  { key: "linked", label: "Vinculados" },
  { key: "unlinked", label: "Sem vínculo" },
] as const;

const LINK_STATE_KEYS = new Set(LINK_STATE_FILTERS.map((f) => f.key as string));

/**
 * Estados aceitos no filtro. Lista fechada de propósito: um valor arbitrário
 * viajaria até o `where l.status = p_status` e devolveria zero linhas, que a
 * tela mostraria como "nenhum anúncio corresponde" — indistinguível de um
 * filtro legítimo sem resultado.
 */
const STATUS_KEYS = new Set(["active", "paused", "closed", "under_review"]);

export function resolveLinkStateFilter(raw: unknown): string {
  return typeof raw === "string" && LINK_STATE_KEYS.has(raw) ? raw : "all";
}

export function resolveStatusFilter(raw: unknown): string | null {
  return typeof raw === "string" && STATUS_KEYS.has(raw) ? raw : null;
}

/**
 * Página 1 é o piso. Valor não numérico, zero, negativo ou fracionário cai em
 * 1 — um `offset` negativo seria erro do Postgres, e a RPC já se protege com
 * `greatest(p_offset, 0)`; aqui a defesa é para a tela não exibir "Página -3".
 */
export function resolvePage(raw: unknown): number {
  return resolvePageParam(raw);
}

export interface WindowSummary {
  label: string;
  totalPages: number;
}

/**
 * A frase que impede a tela de repetir o defeito de D-138.
 *
 * A versão anterior de `/anuncios` mostrava 1.000 de 5.085 anúncios e não
 * dizia nada — não havia como distinguir "estes são todos" de "estes são os
 * primeiros". Dizer sempre "N a M de TOTAL" torna o truncamento impossível de
 * passar despercebido, mesmo que um limite futuro volte a ser baixo demais.
 */
export function summarizeWindow(page: number, totalCount: number, rowsOnPage: number): WindowSummary {
  return summarizePagedWindow({
    page,
    totalCount,
    rowsOnPage,
    pageSize: PAGE_SIZE,
    noun: "anúncios",
    emptyLabel: "Nenhum anúncio no filtro atual.",
  });
}

export interface LinkStateBadge {
  label: string;
  tone: string;
  hint: string;
}

/**
 * O que aparece na coluna SKU quando não há vínculo direto.
 *
 * Os dois casos NÃO são o mesmo, e foi D-122 que estabeleceu isso medindo:
 * dos 1.917 anúncios com `sku_id` nulo, **1.013 têm vínculo por variação** e
 * só **904** não têm vínculo nenhum. Mostrar "—" nos dois, como a tela fazia,
 * dobra o tamanho aparente da fila de trabalho.
 */
export function linkStateBadge(linkState: string): LinkStateBadge {
  if (linkState === "linked_variation") {
    return {
      label: "por variação",
      tone: "var(--sb-text-soft)",
      hint: "O anúncio tem vínculo em nível de variação, não no anúncio inteiro. Não está pendente.",
    };
  }

  return {
    label: "sem vínculo",
    tone: "var(--sb-danger)",
    hint: "Nenhum vínculo, nem por anúncio nem por variação. Aparece na Central de Vinculações.",
  };
}
