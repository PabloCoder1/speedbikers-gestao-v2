import { describe, expect, it } from "vitest";

import {
  PAGE_SIZE,
  buildReplenishmentHref,
  resolveReplenishmentFilters,
  summarizeReplenishmentWindow,
} from "./replenishment-filters";

const vazio = { brand: null, search: null, page: 1 };

describe("resolveReplenishmentFilters", () => {
  it("lê as dimensões da URL", () => {
    const f = resolveReplenishmentFilters({ marca: "NAVETEC", busca: "3001", pagina: "3" });

    expect(f).toEqual({ brand: "NAVETEC", search: "3001", page: 3 });
  });

  it("string vazia e espaços viram null, não filtro que não casa com nada", () => {
    expect(resolveReplenishmentFilters({ marca: "" }).brand).toBeNull();
    expect(resolveReplenishmentFilters({ busca: "   " }).search).toBeNull();
  });

  it("página tem piso 1", () => {
    expect(resolveReplenishmentFilters({ pagina: "0" }).page).toBe(1);
    expect(resolveReplenishmentFilters({ pagina: "abc" }).page).toBe(1);
  });
});

describe("buildReplenishmentHref", () => {
  it("sem filtro nenhum devolve a URL limpa", () => {
    expect(buildReplenishmentHref(vazio, {})).toBe("/reposicao");
  });

  it("preserva as outras dimensões ao trocar uma", () => {
    const atual = { ...vazio, brand: "NAVETEC" };

    expect(buildReplenishmentHref(atual, { search: "manete" })).toBe("/reposicao?marca=NAVETEC&busca=manete");
  });

  it("trocar de filtro VOLTA para a página 1", () => {
    const naPagina5 = { ...vazio, page: 5 };

    expect(buildReplenishmentHref(naPagina5, { brand: "RT" })).not.toContain("pagina");
  });

  it("navegar entre páginas preserva a página pedida", () => {
    const atual = { ...vazio, brand: "RT", page: 2 };

    expect(buildReplenishmentHref(atual, { page: 3 })).toBe("/reposicao?marca=RT&pagina=3");
  });
});

describe("summarizeReplenishmentWindow", () => {
  it("diz o total real, não o tamanho da página", () => {
    const r = summarizeReplenishmentWindow(1, 3276, PAGE_SIZE);

    expect(r.label).toContain("3.276");
    expect(r.label).toContain("1 a 100");
    expect(r.totalPages).toBe(33);
  });

  it("uma página só não vira ruído de intervalo", () => {
    expect(summarizeReplenishmentWindow(1, 40, 40).label).toBe("40 SKUs.");
  });
});
