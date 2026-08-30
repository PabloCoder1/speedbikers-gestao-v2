import { describe, expect, it } from "vitest";

import { simulateCoverageDays, simulateRequiredQuantity, simulateRuptureDate } from "./coverage-simulation.js";

describe("simulateCoverageDays", () => {
  it("divide estoque pela venda média diária, arredondado a 1 casa", () => {
    const result = simulateCoverageDays(100, 3);

    expect(result).toEqual({ stockQuantity: 100, avgDailySales: 3, coverageDays: 33.3 });
  });

  it("venda média diária zero: cobertura indefinida, nunca 'infinita' fingida", () => {
    const result = simulateCoverageDays(50, 0);

    expect(result.coverageDays).toBeNull();
  });

  it("estoque zero com venda real: cobertura zero, não null — é ruptura, não indefinição", () => {
    const result = simulateCoverageDays(0, 5);

    expect(result.coverageDays).toBe(0);
  });

  it("rejeita estoque negativo", () => {
    expect(() => simulateCoverageDays(-1, 5)).toThrow(RangeError);
  });

  it("rejeita venda média diária negativa", () => {
    expect(() => simulateCoverageDays(10, -1)).toThrow(RangeError);
  });

  it("devolve as premissas usadas junto do resultado — nunca só o número isolado", () => {
    const result = simulateCoverageDays(60, 4);

    expect(result.stockQuantity).toBe(60);
    expect(result.avgDailySales).toBe(4);
  });
});

describe("simulateRequiredQuantity", () => {
  it("multiplica dias-alvo pela venda média diária, arredondado para cima", () => {
    const result = simulateRequiredQuantity(10, 3.5);

    expect(result).toEqual({ targetDays: 10, avgDailySales: 3.5, requiredQuantity: 35 });
  });

  it("arredonda para cima — cobertura parcial de um dia ainda é insuficiente", () => {
    const result = simulateRequiredQuantity(10, 3.1);

    expect(result.requiredQuantity).toBe(31);
  });

  it("venda média diária zero: nenhuma unidade necessária", () => {
    const result = simulateRequiredQuantity(30, 0);

    expect(result.requiredQuantity).toBe(0);
  });

  /**
   * Artefato de float que virava unidade INTEIRA (D-150): `90 × (3/30)` dá
   * `9.0000000000000005` em binário, e o `ceil` cru mandava comprar 10
   * quando a conta exata dá 9 — exatamente o caso taxa = units30/30 da
   * sugestão de compra. O produto é saneado na 9ª casa antes do `ceil`,
   * que também é o que mantém a equivalência com a derivação SQL (numeric).
   */
  it("produto com resultado exato não ganha unidade fantasma por artefato binário", () => {
    expect(simulateRequiredQuantity(90, 3 / 30).requiredQuantity).toBe(9);
    expect(simulateRequiredQuantity(30, 0.1).requiredQuantity).toBe(3);
  });

  it("rejeita dias-alvo negativo", () => {
    expect(() => simulateRequiredQuantity(-1, 5)).toThrow(RangeError);
  });
});

describe("simulateRuptureDate", () => {
  it("soma os dias de cobertura (arredondados para baixo) à data de referência", () => {
    const result = simulateRuptureDate("2026-08-01", 100, 3);

    // coverageDays = 33.3 -> Math.floor = 33 dias
    expect(result.ruptureDate).toBe("2026-09-03");
  });

  it("venda média diária zero: ruptura não pode ser estimada", () => {
    const result = simulateRuptureDate("2026-08-01", 100, 0);

    expect(result.ruptureDate).toBeNull();
  });

  it("estoque já zerado: ruptura é hoje", () => {
    const result = simulateRuptureDate("2026-08-01", 0, 5);

    expect(result.ruptureDate).toBe("2026-08-01");
  });

  it("devolve as premissas usadas (asOf, estoque, venda média) junto do resultado", () => {
    const result = simulateRuptureDate("2026-08-15", 40, 2);

    expect(result.asOf).toBe("2026-08-15");
    expect(result.stockQuantity).toBe(40);
    expect(result.avgDailySales).toBe(2);
  });
});
