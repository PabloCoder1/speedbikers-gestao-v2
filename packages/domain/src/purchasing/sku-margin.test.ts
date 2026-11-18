import { describe, expect, it } from "vitest";

import {
  classifyMarginBand,
  consolidateSkuMargins,
  evaluateSkuMargin,
  projectPurchaseMargin,
  type SkuMarginTotals,
} from "./sku-margin.js";

/** Margem por SKU (D-720): a fórmula da casa e o consolidado ponderado. */

function totais(over: Partial<SkuMarginTotals> = {}): SkuMarginTotals {
  return {
    units: 10,
    orders: 10,
    revenue: 1000,
    coveredOrders: 10,
    coveredRevenue: 1000,
    coveredReceived: 830,
    coveredCost: 500,
    currentCostOrders: 0,
    ...over,
  };
}

describe("evaluateSkuMargin", () => {
  it("o exemplo do dono: vendido por 100, recebido 83, custo 50 → 33%", () => {
    const r = evaluateSkuMargin(totais({ revenue: 100, coveredRevenue: 100, coveredReceived: 83, coveredCost: 50 }));

    expect(r.margin).toBe(0.33);
    expect(r.result).toBe(33);
    expect(r.quality).toBe("CONFIAVEL");
  });

  it("margem negativa", () => {
    expect(evaluateSkuMargin(totais({ coveredCost: 900 })).margin).toBe(-0.07);
  });

  it("margem zero real", () => {
    const r = evaluateSkuMargin(totais({ coveredReceived: 500 }));

    expect(r.margin).toBe(0);
    expect(r.quality).toBe("CONFIAVEL");
  });

  it("sem pedido coberto: indisponível, nunca 0%", () => {
    const r = evaluateSkuMargin(totais({ coveredOrders: 0, coveredRevenue: null, coveredReceived: null, coveredCost: null }));

    expect(r.margin).toBeNull();
    expect(r.quality).toBe("INDISPONIVEL");
    expect(r.coverage).toBeNull();
  });

  it("cobertura parcial e custo atual mudam a qualidade", () => {
    expect(evaluateSkuMargin(totais({ coveredRevenue: 500, coveredReceived: 415, coveredCost: 250 })).quality).toBe("PARCIAL");
    expect(evaluateSkuMargin(totais({ currentCostOrders: 2 })).quality).toBe("ESTIMADA");
  });
});

describe("consolidateSkuMargins", () => {
  it("pondera pelos valores, nunca pela média das porcentagens", () => {
    const ml = totais({ revenue: 100, coveredRevenue: 100, coveredReceived: 80, coveredCost: 30 }); // 50%
    const shopee = totais({ revenue: 10000, coveredRevenue: 10000, coveredReceived: 7000, coveredCost: 6000 }); // 10%
    const r = evaluateSkuMargin(consolidateSkuMargins([ml, shopee]));

    expect(r.margin).toBeCloseTo((50 + 1000) / 10100, 4); // ≈ 10,4%, e não 30%
  });

  it("canal sem parte coberta entra só na receita e reduz a cobertura", () => {
    const ml = totais();
    const tiktok = totais({ revenue: 1000, coveredOrders: 0, coveredRevenue: null, coveredReceived: null, coveredCost: null });
    const c = consolidateSkuMargins([ml, tiktok]);
    const r = evaluateSkuMargin(c);

    expect(c.revenue).toBe(2000);
    expect(r.coverage).toBe(0.5);
    expect(r.quality).toBe("PARCIAL");
    expect(r.margin).toBe(0.33);
  });
});

describe("classifyMarginBand", () => {
  it("faixas contra o piso", () => {
    expect(classifyMarginBand(null, 0.1)).toBe("DESCONHECIDA");
    expect(classifyMarginBand(-0.01, 0.1)).toBe("NEGATIVA");
    expect(classifyMarginBand(0.05, 0.1)).toBe("ABAIXO_DO_MINIMO");
    expect(classifyMarginBand(0.1, 0.1)).toBe("SAUDAVEL");
  });
});

describe("projectPurchaseMargin", () => {
  it("Clássico 7% e Premium 17% só como simulação", () => {
    expect(projectPurchaseMargin({ unitPrice: 100, observedReceivedRatio: null, simulatedTier: "CLASSICO", projectedUnitCost: 50 })).toEqual({
      margin: 0.43,
      basis: "SIMULADA",
    });
    expect(projectPurchaseMargin({ unitPrice: 100, observedReceivedRatio: null, simulatedTier: "PREMIUM", projectedUnitCost: 50 }).margin).toBe(0.33);
  });

  it("a razão observada vence a simulação", () => {
    expect(projectPurchaseMargin({ unitPrice: 100, observedReceivedRatio: 0.83, simulatedTier: "CLASSICO", projectedUnitCost: 60 })).toEqual({
      margin: 0.23,
      basis: "OBSERVADA",
    });
  });

  it("sem preço: indisponível", () => {
    expect(projectPurchaseMargin({ unitPrice: 0, observedReceivedRatio: 0.8, simulatedTier: null, projectedUnitCost: 1 }).basis).toBe("INDISPONIVEL");
  });
});
