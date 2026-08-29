/**
 * Regras puras do Dashboard de Anúncios (D-138) — resolução de filtros da URL
 * e a descrição honesta da janela paginada.
 *
 * Mora em `lib/` e não na página para ser testável sem React nem banco, mesmo
 * padrão de `sales-metric.ts` (D-136), `series-alignment.ts` (D-137) e
 * `sku-curation.ts` (D-133).
 */

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
  if (typeof raw !== "string") return 1;

  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
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
  const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / PAGE_SIZE);

  if (totalCount === 0) {
    return { label: "Nenhum anúncio no filtro atual.", totalPages: 0 };
  }

  const first = (page - 1) * PAGE_SIZE + 1;
  const last = first + rowsOnPage - 1;
  const formatted = new Intl.NumberFormat("pt-BR");

  // Uma página só: dizer "1 a 12 de 12" é ruído. O total sozinho já responde.
  if (totalPages === 1) {
    return { label: `${formatted.format(totalCount)} anúncios.`, totalPages };
  }

  return {
    label: `Mostrando ${formatted.format(first)} a ${formatted.format(last)} de ${formatted.format(totalCount)} anúncios.`,
    totalPages,
  };
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
