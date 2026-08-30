import { describe, expect, it } from "vitest";

import { buildFilterHref, resolvePageParam, summarizePagedWindow } from "./filters";

describe("resolvePageParam", () => {
  it("aceita página válida e impõe piso 1", () => {
    expect(resolvePageParam("7")).toBe(7);
    expect(resolvePageParam("1")).toBe(1);
    expect(resolvePageParam("0")).toBe(1);
    expect(resolvePageParam("-3")).toBe(1);
    expect(resolvePageParam("2.9")).toBe(2);
    expect(resolvePageParam("abc")).toBe(1);
    expect(resolvePageParam(undefined)).toBe(1);
    expect(resolvePageParam(["2"])).toBe(1);
  });
});

describe("buildFilterHref", () => {
  it("sem parâmetro nenhum devolve o caminho limpo", () => {
    expect(buildFilterHref("/estoque", {}, 1)).toBe("/estoque");
  });

  /**
   * `null`/`undefined`/`""` são OMITIDOS. É assim que o default fica fora da
   * URL e um link compartilhado carrega só o que foi escolhido de verdade.
   */
  it("omite null, undefined e string vazia", () => {
    expect(buildFilterHref("/x", { a: null, b: undefined, c: "", d: "1" }, 1)).toBe("/x?d=1");
  });

  it("página só aparece a partir da 2", () => {
    expect(buildFilterHref("/x", { a: "1" }, 1)).toBe("/x?a=1");
    expect(buildFilterHref("/x", { a: "1" }, 3)).toBe("/x?a=1&pagina=3");
  });

  it("página sem outros parâmetros ainda produz querystring", () => {
    expect(buildFilterHref("/x", {}, 2)).toBe("/x?pagina=2");
  });

  it("codifica valor com caractere especial", () => {
    expect(buildFilterHref("/x", { marca: "OFF RACER" }, 1)).toBe("/x?marca=OFF+RACER");
  });
});

describe("summarizePagedWindow", () => {
  /**
   * Os números reais que motivaram a extração: `/anuncios` mostrava 1.000 de
   * 5.085 sem dizer nada (D-138) e `/curva-abc`, 1.000 de 1.492 (D-140).
   */
  it("multi-página diz faixa e total", () => {
    const r = summarizePagedWindow({
      page: 1,
      totalCount: 5085,
      rowsOnPage: 50,
      pageSize: 50,
      noun: "anúncios",
      emptyLabel: "vazio",
    });

    expect(r.label).toBe("Mostrando 1 a 50 de 5.085 anúncios.");
    expect(r.totalPages).toBe(102);
  });

  it("última página parcial mostra o intervalo real, não o tamanho cheio", () => {
    const r = summarizePagedWindow({
      page: 8,
      totalCount: 1492,
      rowsOnPage: 92,
      pageSize: 200,
      noun: "SKUs na curva",
      emptyLabel: "vazio",
    });

    expect(r.label).toBe("Mostrando 1.401 a 1.492 de 1.492 SKUs na curva.");
  });

  /** `trailing` só faz sentido quando existe faixa — numa página só vira ruído. */
  it("trailing entra na multi-página e some na página única", () => {
    const comum = { totalCount: 3174, pageSize: 100, noun: "SKUs", trailing: ", em ordem de SKU", emptyLabel: "vazio" };

    expect(summarizePagedWindow({ ...comum, page: 1, rowsOnPage: 100 }).label).toContain(", em ordem de SKU.");
    expect(summarizePagedWindow({ ...comum, totalCount: 40, page: 1, rowsOnPage: 40 }).label).toBe("40 SKUs.");
  });

  it("uma página só responde com o total, sem faixa", () => {
    const r = summarizePagedWindow({
      page: 1,
      totalCount: 12,
      rowsOnPage: 12,
      pageSize: 50,
      noun: "anúncios",
      emptyLabel: "vazio",
    });

    expect(r.label).toBe("12 anúncios.");
    expect(r.totalPages).toBe(1);
  });

  it("zero é resultado e usa a frase da tela, não uma genérica", () => {
    const r = summarizePagedWindow({
      page: 1,
      totalCount: 0,
      rowsOnPage: 0,
      pageSize: 50,
      noun: "anúncios",
      emptyLabel: "Nenhum anúncio no filtro atual.",
    });

    expect(r.label).toBe("Nenhum anúncio no filtro atual.");
    expect(r.totalPages).toBe(0);
  });
});
