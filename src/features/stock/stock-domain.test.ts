import assert from "node:assert/strict";
import test from "node:test";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import {
  calculateKitAvailability,
  classifyStoreName,
  fulfillmentStateHash,
  reconcileAlertLifecycle,
} from "./stock-domain";
import { parseUpsellerPackage } from "../upseller/import-parser";

async function workbook(headers: string[], rows: unknown[][]) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Dados");
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}

test("fixture UpSeller 13014 preserves physical, category-brand and official alias data", async () => {
  const stock = await workbook([
    "SKU", "Título", "Armazém", "Estante", "Estoque Baixo", "Em Trânsito(Compra)",
    "Em Trânsito(Transferência）", "Ocupado", "Disponível", "Estoque Atual", "Custo Médio", "Subtotal", "Criado",
  ], [
    ["13014", "Lâmpada", "ESTOQUE LOJA", "A1", 120, 0, 0, 14, 989, 1003, 15.6635, 15710.8905, "2026-08-14"],
    ["1737", "Componente", "ESTOQUE LOJA", "A2", 0, 0, 0, 0, 5658, 5658, 2, 11316, "2026-08-14"],
  ]);
  const relationshipRows = [
    ["13014", "ALIAS-13014", "", "MLB1322391199", "", "mercado-ML - GMR", "2026-08-14"],
    ["13014", "13014", "", "MLB1987117140", "", "mercado-ML - SbMotos", "2026-08-14"],
    ["13014", "13014", "", "MLB1274711328", "", "mercado-ML- Speedbikers (loja 2)", "2026-08-14"],
    ["13014", "13014", "", "MLB1223918950", "", "mercado-ML- Speedbikers (loja 2)", "2026-08-14"],
    ["13014", "13014", "", "MLB1223919097", "", "mercado-ML- Speedbikers (loja 1)", "2026-08-14"],
  ];
  const relationships = await workbook(
    ["SKU", "Mapeado SKU do Anúncio", "Variante", "ID do Anúncio", "ID da Variante", "Nome da Loja", "Atualizado"],
    relationshipRows,
  );
  const products = await workbook([
    "SKU", "SPU", "Código do Produto", "Título", "Apelido do Produto", "Usar o apelido do produto na NF-e",
    "Categorias", "Variantes1", "Variante1", "Variantes2", "Variante2", "Variantes3", "Variante3",
    "Variantes4", "Variante4", "Variantes5", "Variante5", "Data de Lançamento", "O produto está ativo",
    "Vendedor", "Preço de varejo", "Custo de Compra", "Descrição do Anúncio", "Marca", "Link do Vídeo",
    "Código de Barras", "Apelido de SKU", "Imagem", "Peso (g)", "Comprimento (cm)", "Largura (cm)",
    "Altura (cm)", "NCM", "CEST", "Unidade", "Origem", "Link do Fornecedor",
  ], [[
    "13014", "SPU-1", "P-1", "Lâmpada", "", "Não", "Elétrica", "Cor", "Branca", "", "", "", "", "", "", "", "",
    "", "Sim", "Speed", 49.99, 14.52, "", "Plasmoto", "", "7898442101477;7898667940301", "", "image.jpg",
    100, 10, 5, 5, "8512", "", "UN", "0", "https://supplier.example",
  ]]);
  const kits = await workbook([
    "KIT SKU", "Título", "Apelido do Produto", "Usar o apelido do produto na NF-e", "Categorias",
    "O produto está ativo", "Imagem", "SKU de Produto", "Qtd. SKU de Produto",
  ], [
    ["13014.Lampada.de.Led.H4", "Kit", "", "Não", "Kits", "Sim", "kit.jpg", "13014", 1],
    ["13014.Lampada.de.Led.H4", "Kit", "", "Não", "Kits", "Sim", "kit.jpg", "1737", 1],
  ]);
  const zip = new JSZip();
  zip.file("arbitrary-a.xlsx", products);
  zip.file("arbitrary-b.xlsx", kits);
  const warehouseZip = await zip.generateAsync({ type: "nodebuffer" });
  const parsed = await parseUpsellerPackage({ stock, relationships, warehouseZip });

  assert.equal(parsed.summary.blockingIssues.length, 0);
  const row = parsed.stock.rows.find((candidate) => candidate.sourceSku === "13014");
  assert.deepEqual({
    available: row?.availableQuantity,
    occupied: row?.occupiedQuantity,
    current: row?.currentQuantity,
    low: row?.lowStockThreshold,
  }, { available: 989, occupied: 14, current: 1003, low: 120 });
  assert.equal(row?.currentQuantity, (row?.availableQuantity ?? 0) + (row?.occupiedQuantity ?? 0));
  const master = parsed.products.rows[0];
  assert.equal(master.purchaseCost, 14.52);
  assert.equal(master.retailPrice, 49.99);
  assert.equal(master.brand, "Elétrica");
  assert.deepEqual(master.barcodes, ["7898442101477", "7898667940301"]);
  assert.equal(parsed.summary.aliasRelationshipRows, 1);
  assert.deepEqual(
    parsed.relationships.rows.map((relation) => relation.listingExternalId),
    ["MLB1322391199", "MLB1987117140", "MLB1274711328", "MLB1223918950", "MLB1223919097"],
  );
});

test("kit capacity stays per warehouse and missing stock is UNKNOWN, never zero", () => {
  const ready = calculateKitAvailability(
    [{ skuKey: "13014", requiredQuantity: 1 }, { skuKey: "1737", requiredQuantity: 1 }],
    [
      { skuKey: "13014", warehouseKey: "ESTOQUE LOJA", availableQuantity: 989 },
      { skuKey: "1737", warehouseKey: "ESTOQUE LOJA", availableQuantity: 5658 },
    ],
  );
  assert.equal(ready.ready, true);
  assert.equal(ready.available, 989);
  const unknown = calculateKitAvailability(
    [{ skuKey: "M487", requiredQuantity: 1 }, { skuKey: "M491", requiredQuantity: 1 }],
    [{ skuKey: "M491", warehouseKey: "LOJA", availableQuantity: 10 }],
  );
  assert.equal(unknown.ready, false);
  assert.equal(unknown.available, null);
  assert.deepEqual(unknown.missingComponents, ["M487"]);
});

test("store aliases and Full material hash are deterministic", () => {
  assert.equal(classifyStoreName("mercado-ML- Speedbikers (loja 1)").accountCode, "speedbikers");
  assert.equal(classifyStoreName("mercado-ML- Speedbikers (loja 2)").accountCode, "offracer");
  assert.equal(classifyStoreName("mercado-ML - SbMotos").accountCode, "sb");
  assert.equal(classifyStoreName("mercado-ML - GMR").accountCode, "gmr");
  const state = {
    inventoryId: "ABC123", totalQuantity: 20, availableQuantity: 5, notAvailableQuantity: 15,
    notAvailableDetail: [{ status: "damage", quantity: 15 }], externalReferences: [],
  };
  assert.equal(fulfillmentStateHash(state), fulfillmentStateHash({ ...state }));
});

test("alert lifecycle opens once, remains deduplicated and resolves", () => {
  const opened = reconcileAlertLifecycle([], ["product:1:PHYSICAL_OUT_OF_STOCK"]);
  assert.deepEqual(opened, [{ dedupeKey: "product:1:PHYSICAL_OUT_OF_STOCK", status: "open" }]);
  const unchanged = reconcileAlertLifecycle(opened, ["product:1:PHYSICAL_OUT_OF_STOCK"]);
  assert.equal(unchanged.length, 1);
  assert.equal(unchanged[0].status, "open");
  const resolved = reconcileAlertLifecycle(unchanged, []);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].status, "resolved");
});
