import { describe, expect, it } from "vitest";

import {
  buildDiagnosticHref,
  filterByConfidence,
  resolveConfidence,
  resolveDiagnosticFilters,
  selectDiagnosis,
  type DiagnosticFilters,
} from "./diagnostic-filters";

const base: DiagnosticFilters = { confidence: "todas", selectedSkuId: null };

const diag = (skuId: string, confianca: "media" | "alta") => ({ escopo: { skuId }, confianca });

describe("confiança", () => {
  it("resolve os dois níveis que o domínio tem, mais 'todas'", () => {
    expect(resolveConfidence("alta")).toBe("alta");
    expect(resolveConfidence("media")).toBe("media");
    expect(resolveConfidence("todas")).toBe("todas");
  });

  /**
   * `DiagnosisConfidence` tem DOIS valores. O frame sugere escala mais fina
   * ("Alta · 91%") e há a tentação de aceitar "baixa" — que não existe, e cuja
   * consulta voltaria sempre vazia.
   */
  it("nível que o domínio não tem cai em todas", () => {
    expect(resolveConfidence("baixa")).toBe("todas");
    expect(resolveConfidence("91")).toBe("todas");
    expect(resolveConfidence(undefined)).toBe("todas");
  });

  it("recorta diagnósticos já calculados, sem leitura nova", () => {
    const lista = [diag("a", "alta"), diag("b", "media"), diag("c", "alta")];

    expect(filterByConfidence(lista, "alta")).toHaveLength(2);
    expect(filterByConfidence(lista, "media")).toHaveLength(1);
    expect(filterByConfidence(lista, "todas")).toHaveLength(3);
  });
});

describe("leitura da URL", () => {
  it("lê confiança e SKU selecionado", () => {
    expect(resolveDiagnosticFilters({ confianca: "alta", sku: "abc" })).toEqual({
      confidence: "alta",
      selectedSkuId: "abc",
    });
  });

  it("URL limpa é o default", () => {
    expect(resolveDiagnosticFilters({})).toEqual(base);
  });

  /** SKU só de espaço não seleciona nada — cairia num detalhe inexistente. */
  it("sku em branco não vira seleção", () => {
    expect(resolveDiagnosticFilters({ sku: "   " }).selectedSkuId).toBeNull();
  });
});

describe("seleção do mestre-detalhe", () => {
  it("sem ?sku=, abre na PRIMEIRA — que é a de maior |z|", () => {
    const lista = [diag("forte", "alta"), diag("fraca", "media")];

    expect(selectDiagnosis(lista, null)?.escopo.skuId).toBe("forte");
  });

  it("com ?sku=, abre naquela", () => {
    const lista = [diag("forte", "alta"), diag("fraca", "media")];

    expect(selectDiagnosis(lista, "fraca")?.escopo.skuId).toBe("fraca");
  });

  /**
   * Link velho, ou filtro que tirou o SKU do recorte: cai na primeira em vez
   * de mostrar painel vazio. A tela nunca fica sem detalhe TENDO o que mostrar.
   */
  it("sku fora do recorte cai na primeira, não em painel vazio", () => {
    const lista = [diag("forte", "alta")];

    expect(selectDiagnosis(lista, "sumiu")?.escopo.skuId).toBe("forte");
  });

  it("sem anomalia nenhuma, não há o que selecionar", () => {
    expect(selectDiagnosis([], null)).toBeNull();
    expect(selectDiagnosis([], "qualquer")).toBeNull();
  });
});

describe("href", () => {
  it("o default fica FORA da URL", () => {
    expect(buildDiagnosticHref(base, {})).toBe("/diagnostico");
  });

  it("compõe seleção e filtro sem descartar um ao trocar o outro", () => {
    const comSku = buildDiagnosticHref(base, { selectedSkuId: "abc" });
    expect(comSku).toBe("/diagnostico?sku=abc");

    const atual: DiagnosticFilters = { confidence: "alta", selectedSkuId: "abc" };
    expect(buildDiagnosticHref(atual, {})).toBe("/diagnostico?confianca=alta&sku=abc");
  });
});
