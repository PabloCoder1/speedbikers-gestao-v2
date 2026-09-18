import { describe, expect, it } from "vitest";

import { NOTE_MAX, adjustmentDelta, composeAdjustmentReason } from "./stock-adjustment";

describe("adjustmentDelta", () => {
  it("entrada soma e saída subtrai a quantidade digitada, sempre positiva", () => {
    expect(adjustmentDelta("ENTRADA", 5, 12)).toBe(5);
    expect(adjustmentDelta("SAIDA", 5, 12)).toBe(-5);
  });

  it("balanço grava a diferença entre o contado e o saldo atual", () => {
    expect(adjustmentDelta("BALANCO", 9, 12)).toBe(-3);
    expect(adjustmentDelta("BALANCO", 15, 12)).toBe(3);
    expect(adjustmentDelta("BALANCO", 0, 4)).toBe(-4);
  });

  it("não há o que gravar quando o delta seria zero ou a quantidade é inválida", () => {
    expect(adjustmentDelta("BALANCO", 12, 12)).toBeNull();
    expect(adjustmentDelta("ENTRADA", 0, 12)).toBeNull();
    expect(adjustmentDelta("SAIDA", -2, 12)).toBeNull();
    expect(adjustmentDelta("ENTRADA", Number.NaN, 12)).toBeNull();
  });
});

describe("composeAdjustmentReason", () => {
  it("prefixa a operação e só inclui o que foi preenchido", () => {
    expect(composeAdjustmentReason("SAIDA", "Avaria", "", "")).toBe("Saída · Avaria");
    expect(composeAdjustmentReason("ENTRADA", "Devolução de cliente", " PED-2001 ", "  caixa\n amassada ")).toBe(
      "Entrada · Devolução de cliente · Ref. PED-2001 · caixa amassada",
    );
  });

  it("cabe no limite de 500 caracteres da coluna reason", () => {
    const reason = composeAdjustmentReason("BALANCO", "Inventário periódico", "x".repeat(200), "y".repeat(900));

    expect(reason.length).toBeLessThanOrEqual(500);
    expect(reason.endsWith("y".repeat(NOTE_MAX))).toBe(true);
  });
});
