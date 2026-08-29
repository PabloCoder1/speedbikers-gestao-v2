import { describe, expect, it } from "vitest";

import {
  ABC_CRITERIA,
  PAGE_SIZE,
  buildAbcHref,
  resolveAbcCriterion,
  resolveAbcFilters,
  resolveAbcPeriod,
  summarizeAbcWindow,
} from "./abc-filters";

const base = {
  accountSlug: null,
  criterion: ABC_CRITERIA[0],
  days: 90,
  onlyWithoutFull: false,
  page: 1,
};

describe("critério e período", () => {
  it("resolve os três critérios", () => {
    expect(resolveAbcCriterion("faturamento").key).toBe("faturamento");
    expect(resolveAbcCriterion("unidades").key).toBe("unidades");
    expect(resolveAbcCriterion("pedidos").key).toBe("pedidos");
  });

  it("critério desconhecido cai em faturamento, que era o comportamento anterior", () => {
    expect(resolveAbcCriterion("margem").key).toBe("faturamento");
    expect(resolveAbcCriterion(undefined).key).toBe("faturamento");
  });

  /**
   * Aceitar um número arbitrário deixaria a tela anunciar "últimos 4.000 dias"
   * sobre uma curva que não tem esse dado — número errado com aparência de
   * configuração.
   */
  it("período fora dos presets cai em 90", () => {
    expect(resolveAbcPeriod("30")).toBe(30);
    expect(resolveAbcPeriod("60")).toBe(60);
    expect(resolveAbcPeriod("4000")).toBe(90);
    expect(resolveAbcPeriod("abc")).toBe(90);
    expect(resolveAbcPeriod(undefined)).toBe(90);
  });

  /**
   * A URL antiga ligava o filtro pela mera PRESENÇA de `semFull`, então
   * `?semFull=0` ligava — o oposto do que está escrito.
   */
  it("só `semFull=1` liga o filtro", () => {
    expect(resolveAbcFilters({ semFull: "1" }).onlyWithoutFull).toBe(true);
    expect(resolveAbcFilters({ semFull: "0" }).onlyWithoutFull).toBe(false);
    expect(resolveAbcFilters({}).onlyWithoutFull).toBe(false);
  });

  it("cada critério carrega o ID da definição do catálogo", () => {
    const aprovados = new Set(["receita_bruta", "unidades_vendidas", "pedidos"]);

    for (const c of ABC_CRITERIA) {
      expect(aprovados.has(c.definitionId)).toBe(true);
    }
  });
});

describe("buildAbcHref", () => {
  it("defaults ficam fora da URL", () => {
    expect(buildAbcHref(base, {})).toBe("/curva-abc");
  });

  it("preserva as outras dimensões ao trocar uma", () => {
    const atual = { ...base, accountSlug: "sbmotos", onlyWithoutFull: true };

    expect(buildAbcHref(atual, { days: 30 })).toBe("/curva-abc?conta=sbmotos&dias=30&semFull=1");
  });

  it("trocar filtro volta para a página 1", () => {
    expect(buildAbcHref({ ...base, page: 5 }, { days: 30 })).not.toContain("pagina");
  });

  it("navegar entre páginas preserva a página pedida", () => {
    expect(buildAbcHref({ ...base, page: 2 }, { page: 3 })).toBe("/curva-abc?pagina=3");
  });
});

describe("summarizeAbcWindow", () => {
  /** Os números reais medidos em 2026-08-29, antes e depois do filtro "sem Full". */
  it("descreve a curva inteira, não a página", () => {
    const r = summarizeAbcWindow(1, 1492, PAGE_SIZE);

    expect(r.label).toContain("1.492");
    expect(r.totalPages).toBe(8);
  });

  it("última página parcial mostra o intervalo real", () => {
    expect(summarizeAbcWindow(8, 1492, 92).label).toContain("1.401 a 1.492");
  });

  it("uma página só não vira ruído de intervalo", () => {
    expect(summarizeAbcWindow(1, 150, 150).label).toBe("150 SKUs na curva.");
  });

  it("zero é resultado, não erro", () => {
    expect(summarizeAbcWindow(1, 0, 0).totalPages).toBe(0);
  });
});
