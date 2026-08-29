import { describe, expect, it } from "vitest";

import { PAGE_SIZE, buildStockHref, resolveStockFilters, summarizeStockWindow } from "./stock-filters";

const vazio = { brand: null, category: null, search: null, onlyNegative: false, page: 1 };

describe("resolveStockFilters", () => {
  it("lê as quatro dimensões da URL", () => {
    const f = resolveStockFilters({
      marca: "OFF RACER",
      categoria: "MANETE",
      busca: "3001",
      negativo: "1",
      pagina: "4",
    });

    expect(f).toEqual({
      brand: "OFF RACER",
      category: "MANETE",
      search: "3001",
      onlyNegative: true,
      page: 4,
    });
  });

  /**
   * `?negativo=0` tem que DESLIGAR. Aceitar "qualquer valor presente" faria o
   * zero ligar o filtro — o oposto literal do que o usuário escreveu, e o tipo
   * de defeito que ninguém reporta porque parece "a tela filtrou sozinha".
   */
  it("só `negativo=1` liga o filtro — `0` e vazio não", () => {
    expect(resolveStockFilters({ negativo: "1" }).onlyNegative).toBe(true);
    expect(resolveStockFilters({ negativo: "0" }).onlyNegative).toBe(false);
    expect(resolveStockFilters({ negativo: "true" }).onlyNegative).toBe(false);
    expect(resolveStockFilters({}).onlyNegative).toBe(false);
  });

  it("string vazia e espaços viram null, não filtro que não casa com nada", () => {
    expect(resolveStockFilters({ marca: "" }).brand).toBeNull();
    expect(resolveStockFilters({ busca: "   " }).search).toBeNull();
    expect(resolveStockFilters({ marca: "  RT  " }).brand).toBe("RT");
  });

  it("página tem piso 1", () => {
    expect(resolveStockFilters({ pagina: "0" }).page).toBe(1);
    expect(resolveStockFilters({ pagina: "-2" }).page).toBe(1);
    expect(resolveStockFilters({ pagina: "abc" }).page).toBe(1);
  });
});

describe("buildStockHref", () => {
  it("sem filtro nenhum devolve a URL limpa", () => {
    expect(buildStockHref(vazio, {})).toBe("/estoque");
  });

  it("preserva as outras dimensões ao trocar uma", () => {
    const atual = { ...vazio, brand: "NAVETEC", onlyNegative: true };

    expect(buildStockHref(atual, { search: "manete" })).toBe("/estoque?marca=NAVETEC&busca=manete&negativo=1");
  });

  /**
   * A trava contra a página fantasma: trocar de filtro encolhe o conjunto, e
   * manter o offset mostraria uma página vazia que o usuário lê como "nenhum
   * resultado" — quando na verdade há resultado na página 1.
   */
  it("trocar de filtro VOLTA para a página 1", () => {
    const naPagina7 = { ...vazio, page: 7 };

    expect(buildStockHref(naPagina7, { brand: "RT" })).not.toContain("pagina");
  });

  it("navegar entre páginas preserva a página pedida", () => {
    const atual = { ...vazio, brand: "RT", page: 2 };

    expect(buildStockHref(atual, { page: 3 })).toBe("/estoque?marca=RT&pagina=3");
  });
});

describe("summarizeStockWindow", () => {
  it("diz o total real, não o tamanho da página", () => {
    const r = summarizeStockWindow(1, 3174, PAGE_SIZE);

    expect(r.label).toContain("3.174");
    expect(r.label).toContain("1 a 100");
    expect(r.totalPages).toBe(32);
  });

  it("última página parcial mostra o intervalo real", () => {
    const r = summarizeStockWindow(32, 3174, 74);

    expect(r.label).toContain("3.101 a 3.174");
  });

  it("uma página só não vira ruído de intervalo", () => {
    expect(summarizeStockWindow(1, 40, 40).label).toBe("40 SKUs.");
  });

  it("zero é resultado, não erro", () => {
    expect(summarizeStockWindow(1, 0, 0).totalPages).toBe(0);
  });
});
