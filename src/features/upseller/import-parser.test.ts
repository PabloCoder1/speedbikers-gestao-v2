import assert from "node:assert/strict";
import test from "node:test";

import ExcelJS from "exceljs";

import {
  parseKitWorkbook,
  parseProductWorkbook,
  parseUpsellerPackage,
} from "@/features/upseller/import-parser";

async function createWorkbook(headers: string[], rows: unknown[][], sheetName = "Dados") {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sheetName);
  worksheet.addRow(headers);
  for (const row of rows) worksheet.addRow(row);
  return { workbook, buffer: Buffer.from(await workbook.xlsx.writeBuffer()) };
}

test("UpSeller category is preserved as the canonical brand", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Produtos");
  worksheet.addRow([
    "SKU",
    "SPU",
    "Código do Produto",
    "Título",
    "Categorias",
    "Preço de varejo",
    "Custo de Compra",
    "Marca",
  ]);
  worksheet.addRow([
    "SKU-999",
    "SPU-1",
    "PROD-1",
    "Produto com categoria numérica",
    "999",
    100,
    40,
    "Marca que não deve prevalecer",
  ]);
  worksheet.addRow([
    "SKU-INATIVO",
    "SPU-2",
    "PROD-2",
    "Produto inativo",
    "ESTOQUE INATIVO",
    80,
    20,
    null,
  ]);

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsed = await parseProductWorkbook(buffer);

  assert.deepEqual(parsed.blockingIssues, []);
  assert.equal(parsed.rows[0]?.category, "999");
  assert.equal(parsed.rows[0]?.brand, "999");
  assert.equal(parsed.rows[1]?.category, "ESTOQUE INATIVO");
  assert.equal(parsed.rows[1]?.brand, "ESTOQUE INATIVO");
});

test("four separate UpSeller XLSX files are parsed by their own headers", async () => {
  const { buffer: stock } = await createWorkbook([
    "SKU", "Armazém", "Estoque Baixo", "Em Trânsito(Compra)", "Em Trânsito(Transferência)",
    "Ocupado", "Disponível", "Estoque Atual", "Custo Médio",
  ], [["SKU-1", "LOJA", 0, 0, 0, 0, 10, 10, 5]]);
  const { buffer: relationships } = await createWorkbook([
    "SKU", "Mapeado SKU do Anúncio", "ID do Anúncio", "Nome da Loja",
  ], [["SKU-1", "SKU-1", "MLB123", "mercado-ML- Speedbikers (loja 1)"]]);
  const { buffer: products } = await createWorkbook([
    "SKU", "SPU", "Código do Produto", "Título", "Categorias", "Preço de varejo", "Custo de Compra",
  ], [["SKU-1", "SPU-1", "P-1", "Produto", "NAVETEC", 100, 50]]);
  const { buffer: kits } = await createWorkbook([
    "KIT SKU", "Título", "SKU de Produto", "Qtd. SKU de Produto",
  ], [["KIT-1", "Kit", "SKU-1", 2]]);

  const parsed = await parseUpsellerPackage({ stock, relationships, products, kits });
  assert.equal(parsed.summary.blockingIssues.length, 0);
  assert.equal(parsed.summary.stockRows, 1);
  assert.equal(parsed.summary.productRows, 1);
  assert.equal(parsed.summary.relationshipRows, 1);
  assert.equal(parsed.summary.kitRows, 1);
  assert.equal(parsed.products.rows[0]?.sourceSku, "SKU-1");
  assert.equal(parsed.kits.rows[0]?.kitSku, "KIT-1");
});

test("direct products and kits parsing does not reclassify a workbook as a duplicate product ZIP", async () => {
  const productBook = new ExcelJS.Workbook();
  productBook.addWorksheet("Produtos").addRows([
    ["SKU", "SPU", "Código do Produto", "Título", "Preço de varejo", "Custo de Compra"],
    ["P-1", "SPU-1", "CODE-1", "Produto", 20, 10],
  ]);
  const kitBook = new ExcelJS.Workbook();
  kitBook.addWorksheet("Kits").addRows([
    ["KIT SKU", "SKU de Produto", "Qtd. SKU de Produto"],
    ["KIT-1", "P-1", 1],
  ]);
  kitBook.addWorksheet("Metadados de produto").addRows([
    ["SKU", "SPU", "Código do Produto", "Título", "Preço de varejo", "Custo de Compra"],
    ["IGNORED", "SPU-X", "CODE-X", "Metadado", 1, 1],
  ]);
  const products = Buffer.from(await productBook.xlsx.writeBuffer());
  const kits = Buffer.from(await kitBook.xlsx.writeBuffer());
  assert.equal((await parseProductWorkbook(products)).rows.length, 1);
  assert.equal((await parseKitWorkbook(kits)).rows.length, 1);
});

test("missing exported kit components M487 and 4068 remain warnings", async () => {
  const { buffer: stock } = await createWorkbook([
    "SKU", "Armazém", "Estoque Baixo", "Em Trânsito(Compra)", "Em Trânsito(Transferência)",
    "Ocupado", "Disponível", "Estoque Atual", "Custo Médio",
  ], [["BASE", "LOJA", 0, 0, 0, 0, 1, 1, 1]]);
  const { buffer: relationships } = await createWorkbook([
    "SKU", "Mapeado SKU do Anúncio", "ID do Anúncio", "Nome da Loja",
  ], [["BASE", "BASE", "MLB123", "mercado-ML- Speedbikers (loja 1)"]]);
  const { buffer: products } = await createWorkbook([
    "SKU", "SPU", "Código do Produto", "Título", "Preço de varejo", "Custo de Compra",
  ], [["BASE", "SPU", "P", "Base", 10, 5]]);
  const { buffer: kits } = await createWorkbook([
    "KIT SKU", "SKU de Produto", "Qtd. SKU de Produto",
  ], [["KIT-M487", "M487", 1], ["KIT-4068", "4068", 1]]);
  const parsed = await parseUpsellerPackage({ stock, relationships, products, kits });
  assert.deepEqual(parsed.summary.blockingIssues, []);
  assert.deepEqual(parsed.summary.kitMissingStockComponents.sort(), ["4068", "M487"]);
  assert.equal(parsed.summary.warnings.filter((issue) => issue.code === "kit_component_stock_unknown").length, 2);
});
