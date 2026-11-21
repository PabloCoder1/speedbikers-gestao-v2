import { describe, expect, it } from "vitest";

import { lerNumero } from "./numero-ptbr";

describe("lerNumero", () => {
  it("aceita vírgula decimal, ponto decimal e milhar com vírgula", () => {
    expect(lerNumero("189,90")).toBe(189.9);
    expect(lerNumero("189.90")).toBe(189.9);
    expect(lerNumero("1.234,56")).toBe(1234.56);
    expect(lerNumero("1.234.567,89")).toBe(1234567.89);
    expect(lerNumero(" 42 ")).toBe(42);
    expect(lerNumero("0")).toBe(0);
    expect(lerNumero("-0,5")).toBe(-0.5);
    expect(lerNumero(".5")).toBe(0.5);
    expect(lerNumero(",5")).toBe(0.5);
    expect(lerNumero("189,")).toBe(189);
    expect(lerNumero("189.")).toBe(189);
  });

  it("vazio ou lixo é nulo, nunca zero", () => {
    expect(lerNumero("")).toBeNull();
    expect(lerNumero("   ")).toBeNull();
    expect(lerNumero("abc")).toBeNull();
  });

  it.each(["1.23,45", "1..234,56", "1234.567,89", "12,3.4", "1,2,3", "0x20", "0b10", "1e3", ".", ","])(
    "rejeita %s sem corrigir silenciosamente o valor",
    (entrada) => {
      expect(lerNumero(entrada)).toBeNull();
    },
  );
});
