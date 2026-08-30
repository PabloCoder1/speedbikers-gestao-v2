import { describe, expect, it } from "vitest";

import { classifySalesTrend } from "./sales-trend.js";

const base = { units15: 0, units30: 0, units60: 0, units90: 0, historyDays90: 90 };

describe("classifySalesTrend", () => {
  it("crescendo: taxa recente 25% acima da anterior", () => {
    // 60/30 = 2/dia recente; (150-60)/60 = 1,5/dia anterior; razão 1,333.
    const r = classifySalesTrend({ ...base, units30: 60, units90: 150 });

    expect(r.trend).toBe("CRESCENDO");
    expect(r.ratio).toBeCloseTo(1.333, 2);
  });

  it("caindo: taxa recente 25% abaixo da anterior", () => {
    // 30/30 = 1/dia recente; (150-30)/60 = 2/dia anterior; razão 0,5.
    const r = classifySalesTrend({ ...base, units30: 30, units90: 150 });

    expect(r.trend).toBe("CAINDO");
  });

  it("estável: dentro da banda de ±25%", () => {
    // 33/30 = 1,1/dia; (93-33)/60 = 1/dia; razão 1,1.
    expect(classifySalesTrend({ ...base, units30: 33, units90: 93 }).trend).toBe("ESTAVEL");
  });

  /**
   * As janelas NÃO se sobrepõem: a anterior é (30, 90], nunca "os 90
   * inteiros". Com sobreposição, 60 unidades recentes dentro de um total de
   * 90 dariam razão 60/30 ÷ 90/90 = 2,0 — inflada pelas próprias vendas
   * recentes contadas duas vezes. Sem sobreposição a razão real é 4,0
   * (2/dia contra 0,5/dia): o teste fixa a razão exata para a fórmula não
   * regredir para a versão sobreposta em silêncio.
   */
  it("a janela anterior exclui os últimos 30 dias", () => {
    const r = classifySalesTrend({ ...base, units30: 60, units90: 90 });

    expect(r.rateRecent).toBe(2);
    expect(r.ratePrior).toBe(0.5);
    expect(r.ratio).toBe(4);
  });

  it("menos de 12 unidades em 90 dias é amostra insuficiente — razão sobre ruído não é tendência", () => {
    // 2 vendas antes, 4 agora: "+100%" seria mentira estatística.
    expect(classifySalesTrend({ ...base, units30: 4, units90: 6 }).trend).toBe("AMOSTRA_INSUFICIENTE");
  });

  /**
   * A guarda que nasceu de um caso real: junho tinha 13 de 30 dias
   * recomputados e 86% dos SKUs apareciam "crescendo" por artefato
   * (2026-08-30). O buraco foi consertado; se voltar, a tendência se recusa.
   */
  it("histórico incompleto recusa ANTES de qualquer classificação", () => {
    const r = classifySalesTrend({ ...base, units30: 600, units90: 900, historyDays90: 73 });

    expect(r.trend).toBe("HISTORICO_INCOMPLETO");
  });

  it("a recusa por histórico vence a de amostra — o diagnóstico certo primeiro", () => {
    expect(classifySalesTrend({ ...base, units90: 5, historyDays90: 50 }).trend).toBe("HISTORICO_INCOMPLETO");
  });

  it("SKU que começou a vender agora é crescimento por definição", () => {
    // Tudo nos últimos 30 dias, nada antes: anterior = 0, razão indefinida.
    const r = classifySalesTrend({ ...base, units30: 20, units90: 20 });

    expect(r.trend).toBe("CRESCENDO");
    expect(r.ratio).toBeNull();
  });

  it("limiar é inclusivo nas duas bordas", () => {
    // razão exatamente 1,25 → crescendo; exatamente 0,75 → caindo.
    expect(classifySalesTrend({ ...base, units30: 45, units90: 117 }).ratio).toBeCloseTo(1.25, 10);
    expect(classifySalesTrend({ ...base, units30: 45, units90: 117 }).trend).toBe("CRESCENDO");
    expect(classifySalesTrend({ ...base, units30: 27, units90: 99 }).ratio).toBeCloseTo(0.75, 10);
    expect(classifySalesTrend({ ...base, units30: 27, units90: 99 }).trend).toBe("CAINDO");
  });
});
