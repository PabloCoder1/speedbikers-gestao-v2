import { describe, expect, it } from "vitest";

import { lerNumero } from "./numero-ptbr";

describe("lerNumero", () => {
  it("aceita vírgula decimal, ponto decimal e milhar com vírgula", () => {
    expect(lerNumero("189,90")).toBe(189.9);
    expect(lerNumero("189.90")).toBe(189.9);
    expect(lerNumero("1.234,56")).toBe(1234.56);
    expect(lerNumero(" 42 ")).toBe(42);
  });

  it("vazio ou lixo é nulo, nunca zero", () => {
    expect(lerNumero("")).toBeNull();
    expect(lerNumero("   ")).toBeNull();
    expect(lerNumero("abc")).toBeNull();
  });
});
