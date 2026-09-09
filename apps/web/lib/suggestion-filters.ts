/**
 * Seleção e janela da Central de Sugestões (`/sugestoes`, D30), puras e
 * testáveis sem React nem banco.
 *
 * **A seleção mora na URL** (`?sugestao=`), não em estado React — o frame é
 * mestre-detalhe, e sem isso o link para uma sugestão específica não existiria
 * e o voltar do navegador não funcionaria. É a mesma regra de `/diagnostico`
 * (D-260), a outra tela mestre-detalhe da frente.
 *
 * **Não há filtro de status aqui, e a ausência é decisão.** O frame desenha um
 * botão "Filtrar" no cabeçalho da lista; a tela não tem filtro nenhum hoje, e
 * acrescentá-los é funcionalidade, não composição — mesma linha que recusou a
 * exportação de `/precos` (D-264) e o "Filtrar" de `/notificacoes` (D-269).
 */

import { buildFilterHref, resolvePageParam } from "./filters";

/**
 * Vinte e cinco por página. A tela lia SEM LIMITE e imprimia `rows.length` como
 * "N sugestão(ões) registrada(s)" — o teto de 1.000 do PostgREST faria a frase
 * mentir exatamente como `/acoes` mentia (D-263). Hoje a tabela está vazia, mas
 * a forma do defeito era a mesma.
 */
export const SUGGESTIONS_PAGE_SIZE = 25;

export interface SuggestionFilters {
  /** Sugestão aberta no detalhe. `null` = a tela escolhe a primeira. */
  selectedId: string | null;
  page: number;
}

export function resolveSuggestionFilters(
  query: Record<string, string | string[] | undefined>,
): SuggestionFilters {
  return {
    selectedId:
      typeof query.sugestao === "string" && query.sugestao.trim() !== "" ? query.sugestao.trim() : null,
    page: resolvePageParam(query.pagina),
  };
}

export function buildSuggestionHref(
  current: SuggestionFilters,
  override: Partial<SuggestionFilters>,
): string {
  const next = { ...current, ...override };

  return buildFilterHref("/sugestoes", { sugestao: next.selectedId }, next.page);
}

/**
 * Qual sugestão o detalhe mostra.
 *
 * Sem `?sugestao=`, a PRIMEIRA da página — que é a mais recente, porque a lista
 * ordena por criação decrescente. Com um id que não está na página (link velho,
 * paginação mudou), também cai na primeira em vez de mostrar painel vazio: a
 * tela nunca fica sem detalhe TENDO o que mostrar.
 *
 * É a mesma regra de `selectDiagnosis` em D-260, e está escrita duas vezes de
 * propósito — as duas telas mestre-detalhe têm o mesmo comportamento, e um
 * helper compartilhado sobre tipos diferentes custaria mais do que a repetição
 * de três linhas.
 */
export function selectSuggestion<T extends { readonly id: string }>(
  suggestions: readonly T[],
  selectedId: string | null,
): T | null {
  if (suggestions.length === 0) return null;

  const escolhida = selectedId === null ? undefined : suggestions.find((s) => s.id === selectedId);

  return escolhida ?? suggestions[0] ?? null;
}
