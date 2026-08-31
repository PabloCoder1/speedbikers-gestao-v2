import { describe, expect, it } from "vitest";

import {
  FULL_SITUATIONS,
  buildFullHref,
  fullSituationCriterion,
  fullSituationLabel,
  resolveFullFilters,
} from "./full-filters";

describe("resolveFullFilters", () => {
  it("URL vazia é 'sem filtro', página 1", () => {
    expect(resolveFullFilters({})).toEqual({ search: null, situation: null, account: null, page: 1 });
  });

  it("situação fora do conjunto fechado cai para sem filtro", () => {
    expect(resolveFullFilters({ situacao: "quase-bom" }).situation).toBeNull();

    for (const situation of FULL_SITUATIONS) {
      expect(resolveFullFilters({ situacao: situation }).situation).toBe(situation);
    }
  });

  it("busca em branco é ausência de busca", () => {
    expect(resolveFullFilters({ busca: "  " }).search).toBeNull();
    expect(resolveFullFilters({ busca: " 3001 " }).search).toBe("3001");
  });

  it("página inválida volta para 1", () => {
    expect(resolveFullFilters({ pagina: "-2" }).page).toBe(1);
    expect(resolveFullFilters({ pagina: "5" }).page).toBe(5);
  });
});

describe("buildFullHref", () => {
  const base = resolveFullFilters({ busca: "retrovisor", situacao: "ruptura", pagina: "3" });

  it("trocar de dimensão preserva as outras e volta à página 1", () => {
    expect(buildFullHref(base, { situation: "parado" })).toBe("/full?busca=retrovisor&situacao=parado");
  });

  it("mudar de página preserva os filtros", () => {
    expect(buildFullHref(base, { page: 2 })).toBe("/full?busca=retrovisor&situacao=ruptura&pagina=2");
  });

  it("limpar a situação a remove da URL", () => {
    expect(buildFullHref(base, { situation: null })).toBe("/full?busca=retrovisor");
  });
});

describe("vocabulário das situações", () => {
  it("todas as situações do conjunto têm rótulo e critério declarado", () => {
    for (const situation of FULL_SITUATIONS) {
      expect(fullSituationLabel(situation)).not.toBe(situation);
      expect(fullSituationCriterion(situation).length).toBeGreaterThan(0);
    }
  });

  /**
   * O critério aparece ao lado do nome na tela: chamar um SKU de "ruptura"
   * sem dizer a regra é julgamento sem base declarada.
   */
  it("o critério de ruptura nomeia as duas condições", () => {
    expect(fullSituationCriterion("ruptura")).toContain("vendeu");
    expect(fullSituationCriterion("ruptura")).toContain("ZERO");
  });

  it("é total: situação desconhecida degrada para o valor cru, sem critério inventado", () => {
    expect(fullSituationLabel("situacao_nova_do_worker")).toBe("situacao_nova_do_worker");
    expect(fullSituationCriterion("situacao_nova_do_worker")).toBe("");
  });
});
