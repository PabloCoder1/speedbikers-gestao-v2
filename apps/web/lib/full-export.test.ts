import { describe, expect, it } from "vitest";

import { fullRowsToCsv, type FullExportRow } from "./full-export";

const linha: FullExportRow = {
  sku: "3001",
  sku_title: "Retrovisor; par",
  account_label: "Loja 1",
  situation: "saudavel",
  units_sold: 45,
  daily_rate: 1.5,
  full_quantity: 12,
  coverage_days: 8,
  local_quantity: 3,
  captured_at: "2026-09-18T12:00:00Z",
};

describe("fullRowsToCsv", () => {
  it("abre certo no Excel brasileiro: BOM, ponto e vírgula e vírgula decimal", () => {
    const csv = fullRowsToCsv([linha]);
    const [cabecalho, primeira] = csv.slice(1).split("\r\n");

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(cabecalho).toContain("SKU;Produto;Conta;Situação");
    expect(primeira).toBe('3001;"Retrovisor; par";Loja 1;Saudável;45;1,5;12;8;3;18/09/2026, 09:00');
  });

  it("sem venda a cobertura diz isso, e título com fórmula não executa", () => {
    const csv = fullRowsToCsv([
      { ...linha, sku_title: "=HYPERLINK(1)", coverage_days: null, daily_rate: null, situation: "parado" },
    ]);

    expect(csv).toContain(";'=HYPERLINK(1);");
    expect(csv).toContain(";Parado;45;;12;sem venda;3;");
  });

  it("recorte vazio ainda tem o cabeçalho", () => {
    expect(fullRowsToCsv([]).split("\r\n").filter((l) => l !== "")).toHaveLength(1);
  });
});
