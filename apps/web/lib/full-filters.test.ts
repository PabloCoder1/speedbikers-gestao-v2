import { describe, expect, it } from "vitest";

import {
  FULL_FOCUSES,
  FULL_SITUATIONS,
  FULL_SORTS,
  buildFullHref,
  coverageOf,
  coverageTom,
  formatCoverage,
  fullSortLabel,
  fullSituationCriterion,
  fullSituationLabel,
  resolveFullFilters,
} from "./full-filters";

describe("resolveFullFilters", () => {
  it("URL vazia é 'sem filtro', página 1", () => {
    expect(resolveFullFilters({})).toEqual({
      search: null,
      situation: null,
      account: null,
      focus: null,
      sort: "prioridade",
      pageSize: 50,
      page: 1,
    });
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

describe("foco, ordem e tamanho (D-380)", () => {
  it("foco e ordem são conjuntos fechados; lixo na URL cai no padrão", () => {
    expect(resolveFullFilters({ foco: "tudo", ordem: "aleatorio", tamanho: "999" })).toMatchObject({
      focus: null,
      sort: "prioridade",
      pageSize: 50,
    });

    for (const focus of FULL_FOCUSES) {
      expect(resolveFullFilters({ foco: focus }).focus).toBe(focus);
    }

    for (const sort of FULL_SORTS) {
      expect(resolveFullFilters({ ordem: sort }).sort).toBe(sort);
      expect(fullSortLabel(sort).length).toBeGreaterThan(0);
    }
  });

  it("os padrões ficam fora da URL e o resto é preservado", () => {
    const base = resolveFullFilters({ foco: "acabando", ordem: "vendas", tamanho: "100" });

    expect(buildFullHref(base, { page: 2 })).toBe("/full?foco=acabando&ordem=vendas&tamanho=100&pagina=2");
    expect(buildFullHref(base, { sort: "prioridade", pageSize: 50, focus: null })).toBe("/full");
  });
});

describe("cobertura (D-380)", () => {
  it("o tom segue os limiares declarados na tela", () => {
    expect(coverageTom(null)).toBe("neutro");
    expect(coverageTom(0)).toBe("perigo");
    expect(coverageTom(6.9)).toBe("perigo");
    expect(coverageTom(7)).toBe("atencao");
    expect(coverageTom(14.9)).toBe("atencao");
    expect(coverageTom(15)).toBe("ok");
  });

  it("sem venda não vira número; acima de 90 dias a precisão não diz nada", () => {
    expect(formatCoverage(null)).toBe("sem venda");
    expect(formatCoverage(0)).toBe("0 dias");
    expect(formatCoverage(1)).toBe("1 dia");
    expect(formatCoverage(3.5)).toBe("3,5 dias");
    expect(formatCoverage(18)).toBe("18 dias");
    expect(formatCoverage(240)).toBe("+90 dias");
  });
});

describe("coverageOf — a fórmula da RPC, para o caminho de degradação", () => {
  it("bate com o que a RPC devolve no seed (5 vendidos, 3 no Full, 30 dias)", () => {
    expect(coverageOf(3, 5, 30)).toEqual({ daily_rate: 0.17, coverage_days: 18 });
    expect(coverageOf(0, 40, 30)).toEqual({ daily_rate: 1.33, coverage_days: 0 });
  });

  it("sem venda não há cobertura; saldo negativo conta como zero", () => {
    expect(coverageOf(12, 0, 30)).toEqual({ daily_rate: null, coverage_days: null });
    expect(coverageOf(-2, 10, 30).coverage_days).toBe(0);
  });
});
