import { describe, expect, it } from "vitest";

import { csvCell, csvDocument, csvNumber } from "./csv";

describe("csv", () => {
  it("neutraliza fórmulas e escapa aspas/separador em csvCell", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell(" +SUM(A1:A2)")).toBe("' +SUM(A1:A2)");
    expect(csvCell('a;b"c')).toBe('"a;b""c"');
  });

  it("formata números finitos em pt-BR e devolve vazio para null, NaN e Infinity (D-799)", () => {
    expect(csvNumber(1234.56)).toBe("1234,56");
    expect(csvNumber(null)).toBe("");
    expect(csvNumber(Number.NaN)).toBe("");
    expect(csvNumber(Number.POSITIVE_INFINITY)).toBe("");
    expect(csvNumber(Number.NEGATIVE_INFINITY)).toBe("");
  });

  it("monta documento com BOM e CRLF", () => {
    expect(csvDocument(["A", "B"], [["1", "2"]])).toBe("\uFEFFA;B\r\n1;2\r\n");
  });
});
