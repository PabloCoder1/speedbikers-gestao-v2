import { describe, expect, it } from "vitest";

import { listingsToCsv, type ListingExportRow } from "./listings-export";

const LINHA: ListingExportRow = {
  item_id: "MLB5021016752",
  title: "Bau Traseiro; 45l \"Universal\"",
  sku: "BAU05",
  link_state: "linked",
  account_label: "Speedbikers (loja 1)",
  status: "active",
  price: 329.9,
  available_quantity: 5,
  full_quantity: null,
  units_sold: 265,
  gross_revenue: 78243.98,
  visits: 3914,
  days_observed: 8,
  conversion_rate: 0.0241,
  synced_at: "2026-09-18T16:51:20.000Z",
  permalink: "https://produto.mercadolivre.com.br/MLB-5021016752",
};

describe("CSV de /anuncios", () => {
  it("abre certo no Excel brasileiro: BOM, ponto e vírgula e vírgula decimal", () => {
    const csv = listingsToCsv([LINHA], 30);
    const [cabecalho, linha] = csv.slice(1).split("\r\n");

    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(cabecalho?.split(";")[0]).toBe("MLB");
    expect(linha).toContain(";329,9;");
    expect(linha).toContain(";78243,98;");
    // Conversão em percentual, como na tela.
    expect(linha).toContain(";2,41;");
    expect(linha).toContain(";8/30;");
  });

  it("título com ; e aspas vira uma célula só", () => {
    const linha = listingsToCsv([LINHA], 30).split("\r\n")[1] ?? "";

    expect(linha).toContain('"Bau Traseiro; 45l ""Universal"""');
  });

  it("ausência de dado é célula vazia, nunca zero (D-067)", () => {
    const semDado = listingsToCsv([{ ...LINHA, title: "Bau", visits: null, conversion_rate: null, days_observed: 0 }], 30);
    const campos = (semDado.split("\r\n")[1] ?? "").split(";");

    // Full (8), visitas (11), dias observados (12) e conversão (13) vazios.
    expect([campos[8], campos[11], campos[12], campos[13]]).toEqual(["", "", "", ""]);
  });

  it("título que começa com = não vira fórmula no Excel", () => {
    const linha = listingsToCsv([{ ...LINHA, title: "=HYPERLINK(1)" }], 30).split("\r\n")[1] ?? "";

    expect(linha).toContain(";'=HYPERLINK(1);");
  });
});
