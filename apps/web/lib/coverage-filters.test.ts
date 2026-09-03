import { describe, expect, it } from "vitest";

import { buildCoverageHref, resolveCoverageFilters } from "./coverage-filters";

const base = { brand: null };

describe("marca vinda da URL (D-236)", () => {
  it("lê `marca`, apara espaço e trata vazio como ausência", () => {
    expect(resolveCoverageFilters({ marca: "OFF RACER" }).brand).toBe("OFF RACER");
    expect(resolveCoverageFilters({ marca: "  RT  " }).brand).toBe("RT");
    expect(resolveCoverageFilters({ marca: "" }).brand).toBeNull();
    expect(resolveCoverageFilters({ marca: "   " }).brand).toBeNull();
    expect(resolveCoverageFilters({}).brand).toBeNull();
  });

  it("array na URL (`?marca=a&marca=b`) é ignorado, não concatenado", () => {
    expect(resolveCoverageFilters({ marca: ["OFF RACER", "RT"] }).brand).toBeNull();
  });

  it("marca desconhecida NÃO cai num default — vai ao banco e a tela volta vazia", () => {
    expect(resolveCoverageFilters({ marca: "MARCA-QUE-NAO-EXISTE" }).brand).toBe("MARCA-QUE-NAO-EXISTE");
  });

  it("parâmetro de conta é IGNORADO — estoque físico é da organização, não da conta", () => {
    // Não é lacuna do resolvedor: é a regra do item P1. Um `?conta=` colado na
    // URL não pode virar filtro silencioso de uma dimensão que o dado não tem.
    const comConta = resolveCoverageFilters({ conta: "sbmotos", marca: "RT" });

    expect(comConta).toEqual({ brand: "RT" });
    expect(buildCoverageHref(comConta, {})).toBe("/cobertura?marca=RT");
  });
});

describe("buildCoverageHref", () => {
  it("sem marca, a URL fica limpa", () => {
    expect(buildCoverageHref(base, {})).toBe("/cobertura");
    expect(buildCoverageHref({ brand: "RT" }, { brand: null })).toBe("/cobertura");
  });

  it("marca com espaço é escapada", () => {
    expect(buildCoverageHref(base, { brand: "OFF RACER" })).toBe("/cobertura?marca=OFF+RACER");
  });
});
