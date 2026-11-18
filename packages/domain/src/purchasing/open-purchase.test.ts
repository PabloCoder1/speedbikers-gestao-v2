import { describe, expect, it } from "vitest";

import { assessOpenPurchase, type OpenPurchaseInput } from "./open-purchase.js";
import { computeUsableStock } from "./usable-stock.js";

function input(over: Partial<OpenPurchaseInput> & { local?: number; full?: number; transit?: number; virtual?: boolean }): OpenPurchaseInput {
  const usable = computeUsableStock({
    localQuantity: over.local ?? 100,
    fullQuantity: over.full ?? 0,
    transitQuantity: over.transit ?? 0,
    reservedQuantity: 0,
    stockIsVirtual: over.virtual ?? false,
  });

  return {
    pendingQuantity: 0,
    plannedQuantity: 0,
    nextExpectedDate: null,
    late: false,
    suggestedQuantity: 0,
    dailyRate: 20,
    today: "2026-11-18",
    ...over,
    usable,
  };
}

describe("assessOpenPurchase (D-763)", () => {
  it("cenário 1: 1.000 encomendadas e a sugestão líquida de 200 é a compra complementar", () => {
    const r = assessOpenPurchase(input({ pendingQuantity: 1000, transit: 1000, suggestedQuantity: 200 }));

    expect(r.situation).toBe("ENCOMENDADO_COMPLEMENTAR");
  });

  it("cenário 2: encomendado acima da necessidade — nada novo a comprar", () => {
    expect(assessOpenPurchase(input({ pendingQuantity: 600, transit: 600, suggestedQuantity: 0 })).situation).toBe("ENCOMENDADO_COBRE");
  });

  it("cenário 3: só planejado não muda a necessidade e não tem risco de chegada", () => {
    expect(assessOpenPurchase(input({ plannedQuantity: 500, suggestedQuantity: 1200 }))).toEqual({ situation: "PLANEJADO", risk: null });
  });

  it("sem pedido nenhum", () => {
    expect(assessOpenPurchase(input({ suggestedQuantity: 1200 })).situation).toBe("SEM_PEDIDO");
  });

  it("sem acesso a compras: desconhecido, nunca 'sem pedido'", () => {
    expect(assessOpenPurchase(input({ pendingQuantity: null, plannedQuantity: null }))).toEqual({ situation: "DESCONHECIDA", risk: null });
  });

  it("encomendado com sugestão recusada não vira 'coberto'", () => {
    expect(assessOpenPurchase(input({ pendingQuantity: 50, transit: 50, suggestedQuantity: null })).situation).toBe("ENCOMENDADO_SEM_SUGESTAO");
  });

  describe("cenário 9: risco até a chegada", () => {
    it("100 em estoque a 20/dia aguentam 5 dias; chegada em 40 → ruptura antes da chegada", () => {
      const r = assessOpenPurchase(input({ pendingQuantity: 1200, transit: 1200, suggestedQuantity: 0, nextExpectedDate: "2026-12-28" }));

      expect(r.situation).toBe("ENCOMENDADO_COBRE");
      expect(r.risk).toEqual({ kind: "RUPTURA_ANTES_DA_CHEGADA", daysUntilArrival: 40, coverageWithoutTransitDays: 5 });
    });

    it("o trânsito não conta para a cobertura até a chegada", () => {
      const r = assessOpenPurchase(input({ local: 1000, pendingQuantity: 500, transit: 500, nextExpectedDate: "2026-12-08" }));

      expect(r.risk).toMatchObject({ kind: "CHEGA_A_TEMPO", daysUntilArrival: 20, coverageWithoutTransitDays: 50 });
    });

    it("previsão vencida é atraso", () => {
      expect(assessOpenPurchase(input({ pendingQuantity: 10, transit: 10, late: true, nextExpectedDate: "2026-11-01" })).risk?.kind).toBe("ATRASADO");
    });

    it("sem previsão, o risco é dito como desconhecido", () => {
      expect(assessOpenPurchase(input({ pendingQuantity: 10, transit: 10 })).risk).toMatchObject({ kind: "SEM_PREVISAO", daysUntilArrival: null });
    });

    it("estoque virtual ou sem venda: não há como projetar", () => {
      expect(
        assessOpenPurchase(input({ pendingQuantity: 10, transit: 10, virtual: true, nextExpectedDate: "2026-12-01" })).risk?.kind,
      ).toBe("INDETERMINADO");
      expect(
        assessOpenPurchase(input({ pendingQuantity: 10, transit: 10, dailyRate: 0, nextExpectedDate: "2026-12-01" })).risk?.kind,
      ).toBe("INDETERMINADO");
    });
  });
});
