import { describe, expect, it } from "vitest";

import {
  SUGGESTIONS_PAGE_SIZE,
  buildSuggestionHref,
  resolveSuggestionFilters,
  selectSuggestion,
  type SuggestionFilters,
} from "./suggestion-filters";

const base: SuggestionFilters = { selectedId: null, page: 1 };

describe("leitura da URL", () => {
  it("lê a sugestão aberta e a página", () => {
    expect(resolveSuggestionFilters({ sugestao: "abc", pagina: "3" })).toEqual({
      selectedId: "abc",
      page: 3,
    });
  });

  it("URL limpa é o default", () => {
    expect(resolveSuggestionFilters({})).toEqual(base);
  });

  /** Id só de espaço não seleciona nada — cairia num detalhe inexistente. */
  it("sugestão em branco não vira seleção", () => {
    expect(resolveSuggestionFilters({ sugestao: "   " }).selectedId).toBeNull();
  });
});

describe("href", () => {
  it("o default fica FORA da URL", () => {
    expect(buildSuggestionHref(base, {})).toBe("/sugestoes");
  });

  it("a seleção entra na URL, e é o que torna o detalhe linkável", () => {
    expect(buildSuggestionHref(base, { selectedId: "abc" })).toBe("/sugestoes?sugestao=abc");
  });

  it("paginar preserva a seleção", () => {
    const comSelecao: SuggestionFilters = { selectedId: "abc", page: 1 };

    expect(buildSuggestionHref(comSelecao, { page: 2 })).toBe("/sugestoes?sugestao=abc&pagina=2");
  });
});

describe("seleção do mestre-detalhe", () => {
  const lista = [{ id: "recente" }, { id: "antiga" }];

  it("sem ?sugestao=, abre na PRIMEIRA — que é a mais recente", () => {
    expect(selectSuggestion(lista, null)?.id).toBe("recente");
  });

  it("com ?sugestao=, abre naquela", () => {
    expect(selectSuggestion(lista, "antiga")?.id).toBe("antiga");
  });

  /**
   * Link velho, ou paginação que mudou: cai na primeira em vez de mostrar
   * painel vazio. A tela nunca fica sem detalhe TENDO o que mostrar.
   */
  it("id fora da página cai na primeira, não em painel vazio", () => {
    expect(selectSuggestion(lista, "sumiu")?.id).toBe("recente");
  });

  it("sem sugestão nenhuma, não há o que selecionar", () => {
    expect(selectSuggestion([], null)).toBeNull();
    expect(selectSuggestion([], "qualquer")).toBeNull();
  });
});

describe("janela", () => {
  /**
   * A tela lia SEM LIMITE e imprimia `rows.length` como total. Com o teto de
   * 1.000 do PostgREST, a frase mentiria exatamente como `/acoes` mentia
   * (D-263) — latente só porque a tabela está vazia.
   */
  it("tem tamanho de página declarado", () => {
    expect(SUGGESTIONS_PAGE_SIZE).toBeGreaterThan(0);
    expect(SUGGESTIONS_PAGE_SIZE).toBeLessThan(1000);
  });
});
