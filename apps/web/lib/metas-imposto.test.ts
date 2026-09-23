import { describe, expect, it } from "vitest";

import { formatarAliquota, lerData, lerMes, lerNota, lerPercentual, lerValorEmReais, rotuloDoMes } from "./metas-imposto";

describe("lerValorEmReais", () => {
  it("aceita o dinheiro como se escreve no Brasil", () => {
    for (const [texto, valor] of [
      ["2.800.000", 2_800_000],
      ["2.800.000,50", 2_800_000.5],
      ["R$ 2.800.000,00", 2_800_000],
      ["2800000", 2_800_000],
      ["2.800", 2_800],
      ["1500.75", 1_500.75],
      ["  350000 ", 350_000],
    ] as const) {
      expect(lerValorEmReais(texto), texto).toEqual({ ok: true, valor });
    }
  });

  it("recusa vazio, texto, zero, negativo e duas vírgulas", () => {
    for (const texto of ["", "muito", "0", "-10", "1,000,00", "R$"]) {
      expect(lerValorEmReais(texto).ok, texto).toBe(false);
    }
  });
});

describe("lerPercentual", () => {
  it("converte porcentagem em fração", () => {
    expect(lerPercentual("6,5")).toEqual({ ok: true, valor: 0.065 });
    expect(lerPercentual("6.5%")).toEqual({ ok: true, valor: 0.065 });
    expect(lerPercentual("0")).toEqual({ ok: true, valor: 0 });
    expect(lerPercentual("11,375")).toEqual({ ok: true, valor: 0.11375 });
  });

  it("recusa fora de 0–100% e mais de três casas", () => {
    expect(lerPercentual("100").ok).toBe(false);
    expect(lerPercentual("-1").ok).toBe(false);
    expect(lerPercentual("6,1234").ok).toBe(false);
    expect(lerPercentual("seis").ok).toBe(false);
  });
});

describe("mês, data e nota", () => {
  it("o mês vira o dia 1; mês 13 não passa", () => {
    expect(lerMes("2026-09")).toEqual({ ok: true, valor: "2026-09-01" });
    expect(lerMes("2026-13").ok).toBe(false);
    expect(lerMes("setembro").ok).toBe(false);
  });

  it("a data é conferida de verdade", () => {
    expect(lerData("2026-01-01")).toEqual({ ok: true, valor: "2026-01-01" });
    expect(lerData("2026-02-31").ok).toBe(false);
    expect(lerData("").ok).toBe(false);
  });

  it("nota vazia vira null e longa demais é recusada", () => {
    expect(lerNota("  ")).toEqual({ ok: true, valor: null });
    expect(lerNota("Simples, anexo I")).toEqual({ ok: true, valor: "Simples, anexo I" });
    expect(lerNota("x".repeat(301)).ok).toBe(false);
  });
});

describe("rótulos", () => {
  it("mês por extenso e alíquota sem zero sobrando", () => {
    expect(rotuloDoMes("2026-09-01")).toBe("setembro de 2026");
    expect(formatarAliquota(0.06)).toBe("6%");
    expect(formatarAliquota(0.065)).toBe("6,5%");
    expect(formatarAliquota(0.11375)).toBe("11,375%");
  });
});
