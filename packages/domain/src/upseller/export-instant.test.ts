import { describe, expect, it } from "vitest";

import { resolveStockExportInstant } from "./export-instant.js";

describe("resolveStockExportInstant (D-351)", () => {
  it("o arquivo de producao: exportado as 18:42:00 UTC, parse as 18:44:13 — o corte e a exportacao", () => {
    const parsedAt = new Date("2026-09-14T18:44:13.254Z");

    expect(resolveStockExportInstant("Lista_de_Estoque_0914184200.xlsx", parsedAt).toISOString()).toBe(
      "2026-09-14T18:42:00.000Z",
    );
  });

  it("o arquivo do Dev: exportado 23 h 33 min antes do parse, ainda dentro do limite de 24 h", () => {
    const parsedAt = new Date("2026-08-21T15:42:02.459Z");

    expect(resolveStockExportInstant("Lista_de_Estoque_0820160923.xlsx", parsedAt).toISOString()).toBe(
      "2026-08-20T16:09:23.000Z",
    );
  });

  it("nome sem o padrao (ou nulo) cai no instante do parse — o comportamento de antes", () => {
    const parsedAt = new Date("2026-09-14T18:44:13.254Z");

    expect(resolveStockExportInstant("estoque.xlsx", parsedAt)).toEqual(parsedAt);
    expect(resolveStockExportInstant(null, parsedAt)).toEqual(parsedAt);
    // Os outros tres arquivos da exportacao nao sao de estoque: nao entram.
    expect(resolveStockExportInstant("export_kit_202609141541-20260914184106906001.xlsx", parsedAt)).toEqual(parsedAt);
  });

  it("copia renomeada pelo navegador continua valendo", () => {
    const parsedAt = new Date("2026-09-14T18:44:13.254Z");

    expect(resolveStockExportInstant("Lista_de_Estoque_0914184200 (1).xlsx", parsedAt).toISOString()).toBe(
      "2026-09-14T18:42:00.000Z",
    );
  });

  it("data impossivel cai no parse: mes 13, 30 de fevereiro, hora 24", () => {
    const parsedAt = new Date("2026-03-01T12:00:00.000Z");

    expect(resolveStockExportInstant("Lista_de_Estoque_1314184200.xlsx", parsedAt)).toEqual(parsedAt);
    expect(resolveStockExportInstant("Lista_de_Estoque_0230100000.xlsx", parsedAt)).toEqual(parsedAt);
    expect(resolveStockExportInstant("Lista_de_Estoque_0301240000.xlsx", parsedAt)).toEqual(parsedAt);
  });

  it("exportacao com mais de 24 h vira o piso, nao a data do nome", () => {
    const parsedAt = new Date("2026-09-14T18:44:13.254Z");

    expect(resolveStockExportInstant("Lista_de_Estoque_0912100000.xlsx", parsedAt).toISOString()).toBe(
      "2026-09-13T18:44:13.254Z",
    );
  });

  it("relogio do ERP adiantado alguns minutos vira o teto — nao um ano para tras", () => {
    const parsedAt = new Date("2026-09-14T18:44:13.254Z");

    expect(resolveStockExportInstant("Lista_de_Estoque_0914184700.xlsx", parsedAt)).toEqual(parsedAt);
  });

  it("virada de ano: exportada em 31/12, parse em 01/01 — cai no ano anterior", () => {
    const parsedAt = new Date("2027-01-01T00:05:00.000Z");

    expect(resolveStockExportInstant("Lista_de_Estoque_1231235900.xlsx", parsedAt).toISOString()).toBe(
      "2026-12-31T23:59:00.000Z",
    );
  });

  it("29 de fevereiro so vale em ano bissexto", () => {
    expect(
      resolveStockExportInstant("Lista_de_Estoque_0229100000.xlsx", new Date("2028-02-29T12:00:00.000Z")).toISOString(),
    ).toBe("2028-02-29T10:00:00.000Z");
    // 2026 e 2027 nao sao bissextos: o unico candidato valido e 2028, no FUTURO do
    // parse — o teto o devolve ao parse, o mesmo que "nao deu".
    const parsedAt = new Date("2027-03-01T12:00:00.000Z");

    expect(resolveStockExportInstant("Lista_de_Estoque_0229100000.xlsx", parsedAt)).toEqual(parsedAt);
  });
});
