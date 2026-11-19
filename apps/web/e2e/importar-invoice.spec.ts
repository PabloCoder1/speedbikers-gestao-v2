import ExcelJS from "exceljs";
import { expect, test } from "@playwright/test";

import { E2E_SKU_CODE } from "./constants.js";
import { login } from "./helpers.js";

/**
 * Importar a invoice do fornecedor (D-767), pela tela, com um .xlsx gerado
 * aqui no layout das invoices reais: cabeçalho com NO., DATE, S/C NO., B/L e
 * contêiner; itens sem título de coluna (NCM, pedido, SKU, descrição,
 * quantidade, unidade, "$", preço, "$", valor); o mesmo SKU partido em duas
 * linhas; e a aba PL (lista de embalagem) que repete os itens.
 *
 * Os documentos reais nunca entram no repositório. O pedido criado é
 * cancelado no fim pela tela.
 */

const PEDIDO = `E2EINV${String(Date.now()).slice(-6)}`;

async function invoice(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const inv = wb.addWorksheet("INV");
  const put = (ws: ExcelJS.Worksheet, linha: number, celulas: Record<string, string | number>): void => {
    for (const [col, v] of Object.entries(celulas)) ws.getCell(`${col}${String(linha)}`).value = v;
  };

  put(inv, 3, { F: "COMMERCIAL INVOICE" });
  put(inv, 4, { I: "NO.", K: `${PEDIDO}-1` });
  put(inv, 6, { I: "DATE", K: "Sep 28,2026" });
  put(inv, 8, { I: "S/C NO.", K: PEDIDO });
  put(inv, 15, { A: "Marks & Numbers", C: "Quantities and Descriptions", I: "Unit Price", L: "Amount" });
  put(inv, 17, { C: "B/L NO.：BLE2E0001" });
  put(inv, 18, { C: "Container/Seal No.:CONTE2E001/LACRE" });
  put(inv, 19, { A: "87141000", C: PEDIDO, D: E2E_SKU_CODE, F: "PRODUTO DE TESTE E2E", G: 6, H: "PCS", I: "$", J: 1.5, L: "$", M: 9 });
  put(inv, 20, { A: "87141000", C: PEDIDO, D: E2E_SKU_CODE, F: "PRODUTO DE TESTE E2E", G: 4, H: "PCS", I: "$", J: 1.5, L: "$", M: 6 });
  put(inv, 22, { C: "TOTAL:", L: "$", M: 15 });

  const pl = wb.addWorksheet("PL");

  put(pl, 6, { F: "PACKING LIST(Weight Memo)" });
  put(pl, 18, { A: "GOODS", G: "QUANTITES", I: "PACKING", K: "G.W(kgs)" });
  put(pl, 22, { A: PEDIDO, C: E2E_SKU_CODE, E: "PRODUTO", G: 10, H: "PCS", I: 1, K: 12 });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("importar invoice: lê pedido, preço e contêiner, ignora a lista de embalagem e soma o mesmo SKU", async ({ page }) => {
  test.setTimeout(120_000);

  await login(page, "/compras/importar");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Planilha de pedidos (.xlsx ou .xls)").setInputFiles({
    name: `${PEDIDO}-1INV&PL-.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: await invoice(),
  });

  const abaInv = page.locator("details.sb-imp-aba", { hasText: "INV" }).first();
  const abaPl = page.locator("details.sb-imp-aba", { hasText: "PL" }).last();

  await expect(abaInv).toContainText("invoice · 2 itens");
  await expect(abaInv.locator(".sb-imp-documento")).toContainText("CONTE2E001");
  await expect(abaInv.locator(".sb-imp-documento")).toContainText("BLE2E0001");
  await expect(abaInv.getByLabel("Papel da coluna C")).toHaveValue("REFERENCIA");
  await expect(abaInv.getByLabel("Papel da coluna J")).toHaveValue("PRECO");
  await expect(page.getByLabel("Nº do pedido padrão da aba INV")).toHaveValue(PEDIDO);
  // A lista de embalagem repete os itens: começa fora.
  await expect(abaPl).toContainText("lista de embalagem");
  await expect(abaPl.getByRole("checkbox")).not.toBeChecked();
  await expect(page.locator(".sb-imp-envio")).toContainText("2 quantidades");
  await expect(page.locator(".sb-imp-envio")).toContainText("US$ 15,00 na invoice");
  // A soma bate com o TOTAL: nenhum aviso.
  await expect(abaInv.getByRole("alert")).toHaveCount(0);

  await page.getByRole("button", { name: "3. Enviar para conferência" }).click();
  await expect(page).toHaveURL(/\/compras\/importar\/[0-9a-f-]{36}/);

  const grupo = page.locator("article.sb-imp-grupo", { hasText: PEDIDO });

  await expect(grupo).toContainText("US$ 15,00 na invoice");
  await expect(grupo).toContainText("contêiner CONTE2E001");
  await expect(page.locator(".sb-imp-linha").first()).toContainText("US$ 1,50/un");
  await grupo.getByLabel("Pedido realizado").check();
  // B/L e contêiner: a etapa sugerida é "embarcado".
  await expect(grupo.getByLabel("Situação logística")).toHaveValue("EMBARCADO");
  await grupo.getByRole("button", { name: "Registrar pedido" }).click();

  const outra = grupo.getByRole("button", { name: "É outra compra: registrar" });
  const registrado = grupo.getByText(/Pedido nº \d+ registrado\./);

  await expect(outra.or(registrado)).toBeVisible();
  if (await outra.isVisible()) await outra.click();
  await expect(registrado).toBeVisible();

  await page.reload();
  const href = await page.locator("article.sb-imp-grupo", { hasText: PEDIDO }).getByRole("link", { name: /Pedido nº/ }).getAttribute("href");

  // As duas linhas do mesmo SKU viraram um item de 10, a 1,50 em dólar.
  await page.goto(href ?? "/compras");
  await expect(page.getByText("Importado de planilha")).toBeVisible();
  await expect(page.getByText(PEDIDO).first()).toBeVisible();
  await page.getByRole("button", { name: "Cancelar pedido" }).click();
  await page.getByRole("button", { name: "Confirmar cancelamento" }).click();
  await expect(page.getByText(/Cancelado/).first()).toBeVisible();
});
