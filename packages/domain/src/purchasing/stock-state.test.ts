import { describe, expect, it } from "vitest";

import { classifySalesTrend } from "./sales-trend.js";
import { classifyStockState } from "./stock-state.js";
import { computeUsableStock } from "./usable-stock.js";
import type { ResolvedReplenishmentPolicy } from "./replenishment-policy.js";

/**
 * Como em purchase-suggestion.test.ts, os insumos vêm das próprias peças
 * canônicas — mudança de contrato nelas quebra estes testes junto, de
 * propósito.
 */

const policy: ResolvedReplenishmentPolicy = {
  scope: "MARCA",
  supplierBrand: "NAVETEC",
  skuId: null,
  leadTimeDays: 15,
  targetCoverageDays: 90,
  safetyStockDays: 15,
  maxCoverageDays: 240,
  policyNote: null,
};

/** 30 un/30d — taxa 1,0/dia; janela = 120; ponto de pedido = 30. */
const trend = classifySalesTrend({ units15: 15, units30: 30, units60: 60, units90: 90, historyDays90: 90 });

const stock = (local: number, virtual = false) =>
  computeUsableStock({
    localQuantity: local,
    fullQuantity: 0,
    transitQuantity: 0,
    reservedQuantity: 0,
    stockIsVirtual: virtual,
  });

describe("classifyStockState", () => {
  it("RUPTURA: aproveitável zerado (ou devido) com demanda recente", () => {
    expect(classifyStockState({ policy, trend, usable: stock(0) }).state).toBe("RUPTURA");
    expect(classifyStockState({ policy, trend, usable: stock(-5) }).state).toBe("RUPTURA");
  });

  it("COMPRA_URGENTE: cobertura dentro do prazo — mesmo comprando agora, esgota antes de chegar", () => {
    // 15 unidades a 1/dia = 15 dias, exatamente o prazo — inclusive no limite.
    const r = classifyStockState({ policy, trend, usable: stock(15) });

    expect(r.state).toBe("COMPRA_URGENTE");
    expect(r.coverageDays).toBe(15);
  });

  it("COMPRAR_EM_BREVE: acima do prazo, dentro do ponto de pedido (prazo + segurança)", () => {
    const r = classifyStockState({ policy, trend, usable: stock(30) });

    expect(r.state).toBe("COMPRAR_EM_BREVE");
    expect(r.thresholds.reorderPointDays).toBe(30);
  });

  it("COBERTURA_BAIXA: abaixo da janela de demanda — onde a sugestão já dá número", () => {
    expect(classifyStockState({ policy, trend, usable: stock(60) }).state).toBe("COBERTURA_BAIXA");
    expect(classifyStockState({ policy, trend, usable: stock(119) }).state).toBe("COBERTURA_BAIXA");
  });

  it("ADEQUADA: da janela ao teto, inclusive nos dois limites", () => {
    expect(classifyStockState({ policy, trend, usable: stock(120) }).state).toBe("ADEQUADA");
    expect(classifyStockState({ policy, trend, usable: stock(240) }).state).toBe("ADEQUADA");
  });

  it("EXCESSO: acima do teto configurado", () => {
    const r = classifyStockState({ policy, trend, usable: stock(241) });

    expect(r.state).toBe("EXCESSO");
    expect(r.thresholds.maxCoverageDays).toBe(240);
  });

  /**
   * "Quanto é demais" é decisão do ADMIN, não constante do código. Sem teto,
   * EXCESSO nunca é afirmado — 3.000 dias de cobertura continuam ADEQUADA,
   * e a tela diz que o teto não foi configurado.
   */
  it("sem teto configurado, EXCESSO nunca é afirmado", () => {
    const semTeto = { ...policy, maxCoverageDays: null };
    const r = classifyStockState({ policy: semTeto, trend, usable: stock(3000) });

    expect(r.state).toBe("ADEQUADA");
    expect(r.coverageDays).toBe(3000);
  });

  /**
   * Taxa zero torna a cobertura INDEFINIDA (contrato de D-080 — nunca
   * "infinita" fingida), e sem régua nenhum dos cinco estados é defensável.
   * O caso é real: units30 = 0 com units90 ≥ 12 passa pela porta da amostra.
   */
  it("SEM_DEMANDA_RECENTE: taxa zero nos 30 dias — sem régua, sem selo", () => {
    const parado = classifySalesTrend({ units15: 0, units30: 0, units60: 10, units90: 20, historyDays90: 90 });
    const r = classifyStockState({ policy, trend: parado, usable: stock(500) });

    expect(r.state).toBeNull();
    expect(r.refusals).toEqual(["SEM_DEMANDA_RECENTE"]);
    expect(r.coverageDays).toBeNull();
  });

  it("as quatro recusas da sugestão se propagam — sem configuração, sem selo", () => {
    const r = classifyStockState({ policy: null, trend, usable: stock(60) });

    expect(r.state).toBeNull();
    expect(r.refusals).toEqual(["SEM_CONFIGURACAO"]);
    // A cobertura NÃO depende da política — continua exposta.
    expect(r.coverageDays).toBe(60);
    expect(r.thresholds.demandWindowDays).toBeNull();
  });

  it("estoque virtual: sem total confiável, sem cobertura e sem selo", () => {
    const r = classifyStockState({ policy, trend, usable: stock(999, true) });

    expect(r.state).toBeNull();
    expect(r.refusals).toEqual(["ESTOQUE_VIRTUAL"]);
    expect(r.coverageDays).toBeNull();
  });

  it("a cobertura usa a fórmula de D-080 — arredondada a 1 casa como no simulador", () => {
    // 100 unidades a 1,0/dia... taxa 0,2333 (7/30): 50 ÷ 0,2333 = 214,3.
    const lento = classifySalesTrend({ units15: 3, units30: 7, units60: 14, units90: 21, historyDays90: 90 });
    const r = classifyStockState({ policy, trend: lento, usable: stock(50) });

    expect(r.coverageDays).toBe(214.3);
    expect(r.state).toBe("ADEQUADA");
  });
});
