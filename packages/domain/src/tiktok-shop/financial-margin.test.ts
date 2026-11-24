import { describe, expect, it } from "vitest";

import { consolidateTikTokMargins, evaluateTikTokOrderMargin } from "./financial-margin.js";

describe("margem financeira do TikTok Shop (D-809, fórmula oficial V3)", () => {
  it("calcula margem REALIZADA com ((Recebido após taxas − CPV) / Valor bruto) × 100", () => {
    // Recebido 165.40, CPV 2 * 45 = 90, Bruto 200 -> lucro 75.40 -> margem 37.70%
    const res = evaluateTikTokOrderMargin({
      orderId: "ord-1",
      basis: "REALIZADO",
      grossAmount: "200.00",
      netReceivedAmount: "165.40",
      feeAndTaxAmount: "-34.60",
      feePerItemSoldAmount: "-8.00",
      shippingCostAmount: "0.00",
      items: [{ quantity: 2, unitCost: 45 }],
    });

    expect(res).toEqual({
      orderId: "ord-1",
      basis: "REALIZADO",
      grossAmount: 200,
      netReceivedAmount: 165.4,
      feeAndTaxAmount: -34.6,
      feePerItemSoldAmount: -8,
      shippingCostAmount: 0,
      cogsAmount: 90,
      profitAmount: 75.4,
      marginPct: 37.7,
      covered: true,
      missingReason: null,
    });
  });

  it("preserva base ESTIMADO e nunca transforma ausência de custo, receita ou recebido em zero", () => {
    const semCusto = evaluateTikTokOrderMargin({
      orderId: "ord-sem-custo",
      basis: "ESTIMADO",
      grossAmount: 150,
      netReceivedAmount: 120,
      items: [{ quantity: 1, unitCost: null }],
    });

    expect(semCusto.covered).toBe(false);
    expect(semCusto.cogsAmount).toBeNull();
    expect(semCusto.profitAmount).toBeNull();
    expect(semCusto.marginPct).toBeNull();
    expect(semCusto.missingReason).toBe("custo_ausente");

    const semRecebido = evaluateTikTokOrderMargin({
      orderId: "ord-sem-fin",
      basis: "ESTIMADO",
      grossAmount: 150,
      netReceivedAmount: null,
      items: [{ quantity: 1, unitCost: 50 }],
    });

    expect(semRecebido.covered).toBe(false);
    expect(semRecebido.marginPct).toBeNull();
    expect(semRecebido.missingReason).toBe("financeiro_ausente");

    const brutoZero = evaluateTikTokOrderMargin({
      orderId: "ord-bruto-zero",
      basis: "REALIZADO",
      grossAmount: 0,
      netReceivedAmount: 0,
      items: [{ quantity: 1, unitCost: 10 }],
    });

    expect(brutoZero.covered).toBe(false);
    expect(brutoZero.marginPct).toBeNull();
    expect(brutoZero.missingReason).toBe("valor_bruto_invalido");

    const custoInvalido = evaluateTikTokOrderMargin({
      orderId: "ord-custo-neg",
      basis: "REALIZADO",
      grossAmount: 100,
      netReceivedAmount: 80,
      items: [{ quantity: 1, unitCost: -5 }],
    });

    expect(custoInvalido.covered).toBe(false);
    expect(custoInvalido.missingReason).toBe("custo_ausente");
  });

  it("consolida margem ponderada pela soma dos lucros dividida pela soma dos valores brutos", () => {
    // Pedido A: bruto 100, recebido 90, CPV 50 -> lucro 40 (40%)
    // Pedido B: bruto 300, recebido 210, CPV 150 -> lucro 60 (20%)
    // Consolidado ponderado = (40 + 60) / (100 + 300) = 100 / 400 = 25% (NÃO média simples 30%!)
    const a = evaluateTikTokOrderMargin({
      orderId: "a",
      basis: "REALIZADO",
      grossAmount: 100,
      netReceivedAmount: 90,
      items: [{ quantity: 1, unitCost: 50 }],
    });
    const b = evaluateTikTokOrderMargin({
      orderId: "b",
      basis: "ESTIMADO",
      grossAmount: 300,
      netReceivedAmount: 210,
      items: [{ quantity: 3, unitCost: 50 }],
    });
    const c = evaluateTikTokOrderMargin({
      orderId: "c",
      basis: "ESTIMADO",
      grossAmount: 200,
      netReceivedAmount: 170,
      items: [{ quantity: 1, unitCost: null }],
    });

    const consolidado = consolidateTikTokMargins([a, b, c]);

    expect(consolidado).toEqual({
      totalOrders: 3,
      coveredOrders: 2,
      realizedOrders: 1,
      estimatedOrders: 1,
      missingCostOrders: 1,
      missingFinancialOrders: 0,
      coveredGrossAmount: 400,
      coveredNetReceivedAmount: 300,
      coveredCogsAmount: 200,
      coveredProfitAmount: 100,
      consolidatedMarginPct: 25,
    });

    expect(consolidateTikTokMargins([c]).consolidatedMarginPct).toBeNull();
    expect(consolidateTikTokMargins([]).consolidatedMarginPct).toBeNull();
  });
});
