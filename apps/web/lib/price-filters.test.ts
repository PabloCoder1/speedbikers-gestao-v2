import { describe, expect, it } from "vitest";

import { buildPriceHref, priceDirectionLabel, resolvePriceFilters } from "./price-filters";

describe("resolvePriceFilters", () => {
  it("URL vazia é 'sem filtro', página 1", () => {
    expect(resolvePriceFilters({})).toEqual({
      search: null,
      direction: null,
      account: null,
      dateFrom: null,
      dateTo: null,
      page: 1,
    });
  });

  it("direção fora do conjunto fechado cai para sem filtro, não vira erro", () => {
    expect(resolvePriceFilters({ direcao: "lateral" }).direction).toBeNull();
    expect(resolvePriceFilters({ direcao: "up" }).direction).toBe("up");
    expect(resolvePriceFilters({ direcao: "down" }).direction).toBe("down");
  });

  it("data só passa no formato do dia civil", () => {
    expect(resolvePriceFilters({ de: "2026-08-24" }).dateFrom).toBe("2026-08-24");
    expect(resolvePriceFilters({ de: "24/08/2026" }).dateFrom).toBeNull();
    expect(resolvePriceFilters({ ate: "ontem" }).dateTo).toBeNull();
  });

  it("busca em branco é ausência de busca, não busca por espaço", () => {
    expect(resolvePriceFilters({ busca: "   " }).search).toBeNull();
    expect(resolvePriceFilters({ busca: " MLB123 " }).search).toBe("MLB123");
  });

  it("página inválida volta para 1", () => {
    expect(resolvePriceFilters({ pagina: "0" }).page).toBe(1);
    expect(resolvePriceFilters({ pagina: "-3" }).page).toBe(1);
    expect(resolvePriceFilters({ pagina: "abc" }).page).toBe(1);
    expect(resolvePriceFilters({ pagina: "7" }).page).toBe(7);
  });
});

describe("buildPriceHref", () => {
  const base = resolvePriceFilters({ busca: "guidao", direcao: "down", pagina: "4" });

  it("trocar de dimensão preserva as outras e volta à página 1", () => {
    expect(buildPriceHref(base, { direction: "up" })).toBe("/precos?busca=guidao&direcao=up");
  });

  it("mudar de página preserva os filtros", () => {
    expect(buildPriceHref(base, { page: 2 })).toBe("/precos?busca=guidao&direcao=down&pagina=2");
  });

  it("limpar uma dimensão a remove da URL", () => {
    expect(buildPriceHref(base, { direction: null })).toBe("/precos?busca=guidao");
  });
});

describe("priceDirectionLabel", () => {
  it("traduz o conjunto conhecido", () => {
    expect(priceDirectionLabel("up")).toBe("Aumentos");
    expect(priceDirectionLabel("down")).toBe("Reduções");
  });

  it("é total: valor desconhecido degrada para o próprio valor", () => {
    expect(priceDirectionLabel("sideways")).toBe("sideways");
  });
});
