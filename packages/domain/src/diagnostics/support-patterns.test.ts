import { describe, expect, it } from "vitest";

import type { SkuClaimAggregate } from "./support-patterns.js";
import { SUPPORT_PATTERN_MIN_OPEN_CLAIMS, detectSupportPatterns } from "./support-patterns.js";

const BASE: SkuClaimAggregate = {
  skuId: "11111111-0000-4000-8000-00000000a001",
  sku: "5821",
  title: "Baú 45L",
  openClaims: 3,
  openMediations: 0,
  linkedOrdersTotalBrl: 1250.5,
};

describe("detectSupportPatterns (D-116)", () => {
  it("3 reclamações abertas no mesmo SKU viram um achado", () => {
    const [finding] = detectSupportPatterns([BASE]);

    expect(finding?.openClaims).toBe(3);
    expect(finding?.impactBrl).toBe(1250.5);
    expect(finding?.evidencias.map((item) => item.tipo)).toEqual(["reclamacoes_abertas", "valor_em_risco"]);
  });

  it("abaixo do limiar NÃO vira ação — um atendimento individual não é padrão", () => {
    expect(detectSupportPatterns([{ ...BASE, openClaims: SUPPORT_PATTERN_MIN_OPEN_CLAIMS - 1 }])).toEqual([]);
  });

  it("a chave é por SKU e SEM data — condição persistente atualiza a MESMA ação", () => {
    // Semântica de D-064: reprocessar não reabre o que um humano resolveu, e
    // uma chave com data criaria uma ação nova por dia para o mesmo problema.
    const [finding] = detectSupportPatterns([BASE]);

    expect(finding?.dedupKey).toBe(`support_pattern:claims:${BASE.skuId}`);
  });

  it("mediações entram como evidência própria quando existem", () => {
    const [finding] = detectSupportPatterns([{ ...BASE, openMediations: 2 }]);

    expect(finding?.evidencias.some((item) => item.tipo === "mediacoes")).toBe(true);
    expect(finding?.openMediations).toBe(2);
  });

  it("sem valor vinculado, impacto é null — desconhecido não é zero", () => {
    const [finding] = detectSupportPatterns([{ ...BASE, linkedOrdersTotalBrl: null }]);

    expect(finding?.impactBrl).toBeNull();
    expect(finding?.evidencias.some((item) => item.tipo === "valor_em_risco")).toBe(false);
  });
});
