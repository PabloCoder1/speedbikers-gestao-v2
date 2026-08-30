import { describe, expect, it } from "vitest";

import { classifySalesTrend } from "./sales-trend.js";
import { computeUsableStock } from "./usable-stock.js";
import { computePurchaseSuggestion } from "./purchase-suggestion.js";
import type { ResolvedReplenishmentPolicy } from "./replenishment-policy.js";

/**
 * Os insumos vêm das PRÓPRIAS peças canônicas (D-144/145/146), nunca de
 * objetos montados à mão — se uma delas mudar de contrato, estes testes
 * quebram junto, que é o comportamento desejado.
 */

const policy: ResolvedReplenishmentPolicy = {
  scope: "MARCA",
  supplierBrand: "NAVETEC",
  skuId: null,
  leadTimeDays: 15,
  targetCoverageDays: 90,
  safetyStockDays: 15,
  policyNote: null,
};

/** 30 un/30d (taxa 1,0), amostra e histórico suficientes. */
const healthyTrend = classifySalesTrend({ units15: 15, units30: 30, units60: 60, units90: 90, historyDays90: 90 });

const stock = (local: number, full = 0, transit = 0, virtual = false) =>
  computeUsableStock({
    localQuantity: local,
    fullQuantity: full,
    transitQuantity: transit,
    reservedQuantity: 0,
    stockIsVirtual: virtual,
  });

describe("computePurchaseSuggestion", () => {
  it("a conta inteira: taxa × janela − aproveitável, com a decomposição exposta", () => {
    // 1,0/dia × (15+90+15) = 120 projetado; aproveitável 40+8 = 48 → comprar 72.
    const r = computePurchaseSuggestion({ policy, trend: healthyTrend, usable: stock(40, 8) });

    expect(r.refusals).toEqual([]);
    expect(r.suggestedQuantity).toBe(72);
    expect(r.breakdown).toEqual({ dailyRate: 1, demandWindowDays: 120, projectedDemand: 120, usableStock: 48 });
  });

  /**
   * LOCAL negativo AUMENTA a sugestão: -5 são unidades já vendidas que o
   * estoque não tinha — a compra precisa cobrir a janela E a dívida. É o
   * motivo de D-146 não truncar em zero.
   */
  it("aproveitável negativo aumenta a sugestão — a dívida entra na compra", () => {
    const r = computePurchaseSuggestion({ policy, trend: healthyTrend, usable: stock(-5) });

    expect(r.suggestedQuantity).toBe(125);
  });

  it("aproveitável cobrindo a janela sugere ZERO — resposta, não recusa", () => {
    const r = computePurchaseSuggestion({ policy, trend: healthyTrend, usable: stock(200) });

    expect(r.refusals).toEqual([]);
    expect(r.suggestedQuantity).toBe(0);
  });

  it("projeção arredonda para CIMA, o mesmo lado de simulateRequiredQuantity", () => {
    // 7 un/30d = 0,2333/dia × 120 = 28,0 → mas 28 exato? 7/30*120 = 28. Usa 100 dias: 23,33 → 24.
    const trend = classifySalesTrend({ units15: 4, units30: 7, units60: 14, units90: 21, historyDays90: 90 });
    const shortPolicy = { ...policy, leadTimeDays: 10, targetCoverageDays: 80, safetyStockDays: 10 };
    const r = computePurchaseSuggestion({ policy: shortPolicy, trend, usable: stock(0) });

    expect(r.breakdown.projectedDemand).toBe(24);
    expect(r.suggestedQuantity).toBe(24);
  });

  it("sem configuração aplicável: recusa, sem janela e sem número — nunca default", () => {
    const r = computePurchaseSuggestion({ policy: null, trend: healthyTrend, usable: stock(40) });

    expect(r.refusals).toEqual(["SEM_CONFIGURACAO"]);
    expect(r.suggestedQuantity).toBeNull();
    expect(r.breakdown.demandWindowDays).toBeNull();
    expect(r.breakdown.projectedDemand).toBeNull();
    // O que já dá para ver continua exposto.
    expect(r.breakdown.dailyRate).toBe(1);
    expect(r.breakdown.usableStock).toBe(40);
  });

  it("estoque virtual: a recusa de D-146 se propaga", () => {
    const r = computePurchaseSuggestion({ policy, trend: healthyTrend, usable: stock(999, 30, 0, true) });

    expect(r.refusals).toEqual(["ESTOQUE_VIRTUAL"]);
    expect(r.suggestedQuantity).toBeNull();
    expect(r.breakdown.usableStock).toBeNull();
    // A projeção não depende do estoque — continua visível.
    expect(r.breakdown.projectedDemand).toBe(120);
  });

  it("histórico incompleto: a recusa de D-145 se propaga", () => {
    const trend = classifySalesTrend({ units15: 15, units30: 30, units60: 60, units90: 90, historyDays90: 60 });
    const r = computePurchaseSuggestion({ policy, trend, usable: stock(40) });

    expect(r.refusals).toEqual(["HISTORICO_INCOMPLETO"]);
    expect(r.suggestedQuantity).toBeNull();
  });

  it("amostra insuficiente: taxa de 5 vendas/trimestre é ruído, não projeção", () => {
    const trend = classifySalesTrend({ units15: 1, units30: 2, units60: 3, units90: 5, historyDays90: 90 });
    const r = computePurchaseSuggestion({ policy, trend, usable: stock(40) });

    expect(r.refusals).toEqual(["AMOSTRA_INSUFICIENTE"]);
    expect(r.suggestedQuantity).toBeNull();
  });

  /**
   * TODAS as recusas aplicáveis, não só a primeira: quem resolver a
   * configuração de um SKU virtual precisa saber que ainda falta o ensaio de
   * `/produtos` — descobrir recusa por recusa seria a tela escondendo o
   * caminho inteiro.
   */
  it("recusas se acumulam — configurar não basta se o SKU é virtual", () => {
    const r = computePurchaseSuggestion({ policy: null, trend: healthyTrend, usable: stock(999, 0, 0, true) });

    expect(r.refusals).toEqual(["SEM_CONFIGURACAO", "ESTOQUE_VIRTUAL"]);
    expect(r.suggestedQuantity).toBeNull();
  });
});
