import assert from "node:assert/strict";
import test from "node:test";

import ExcelJS from "exceljs";

import {
  buildReplenishmentAlerts,
  calculateCoverageDays,
  calculateKitAvailability,
  chooseInventoryLink,
  classifyStoreName,
  fulfillmentStateHash,
  purchaseLeadTimeDays,
  reconcileAlertLifecycle,
} from "./stock-domain";
import { deriveDottedKitDefinition, parseUpsellerPackage } from "../upseller/import-parser";

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
  const parsed = await parseUpsellerPackage({ stock, relationships, products, kits });

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

test("dot kits are deterministic, count repetitions and reject incomplete definitions", () => {
  const available = new Set(["13018", "1737", "AM0011"]);
  const simple = deriveDottedKitDefinition("13018.1737", available);
  assert.deepEqual(simple.definition?.components, [
    { componentSku: "13018", componentSkuKey: "13018", requiredQuantity: 1 },
    { componentSku: "1737", componentSkuKey: "1737", requiredQuantity: 1 },
  ]);

  const repeated = deriveDottedKitDefinition("AM0011.AM0011", available);
  assert.deepEqual(repeated.definition?.components, [
    { componentSku: "AM0011", componentSkuKey: "AM0011", requiredQuantity: 2 },
  ]);

  const missing = deriveDottedKitDefinition("13018.MISSING", available);
  assert.equal(missing.definition, null);
  assert.deepEqual(missing.unresolved?.missingComponentSkuKeys, ["MISSING"]);
  assert.equal(deriveDottedKitDefinition("1057.", new Set(["1057"])).unresolved?.reason, "invalid_dot_pattern");
  assert.equal(deriveDottedKitDefinition("13018-1737", available).definition, null);
});

test("purchase lead time follows the official brand rules", () => {
  assert.equal(purchaseLeadTimeDays("OFFRACER"), 90);
  assert.equal(purchaseLeadTimeDays("OFF RACER"), 90);
  assert.equal(purchaseLeadTimeDays("navetec"), 90);
  assert.equal(purchaseLeadTimeDays("PLASMOTO"), 15);
});

test("stock hierarchy buys from physical before replenishing Full", () => {
  const base = {
    sourceSku: "13014",
    brand: "PLASMOTO",
    unitsSold30: 60,
    avgDailySales30: 2,
    salesVelocityReady: true,
    fullAccounts: [{
      accountId: "account-1", accountCode: "speedbikers", accountName: "Speed Bikers",
      inventoryCount: 1, pendingInventoryCount: 0, available: 0, checkedAt: "2026-08-17T00:00:00Z",
    }],
  };
  const physicalZero = buildReplenishmentAlerts({
    ...base, physicalReady: true, physicalAvailable: 0, physicalCoverageDays: 0,
  });
  assert.ok(physicalZero.some((alert) => alert.alertType === "PURCHASE_REPLENISHMENT_REQUIRED"));
  assert.ok(!physicalZero.some((alert) => alert.alertType === "FULL_REPLENISH_FROM_PHYSICAL"));

  const physicalAvailable = buildReplenishmentAlerts({
    ...base, physicalReady: true, physicalAvailable: 20, physicalCoverageDays: 10,
  });
  assert.ok(physicalAvailable.some((alert) => alert.alertType === "FULL_REPLENISH_FROM_PHYSICAL"));
  assert.ok(physicalAvailable.some((alert) => alert.alertType === "PURCHASE_REPLENISHMENT_DUE"));

  const notReady = buildReplenishmentAlerts({
    ...base, physicalReady: false, physicalAvailable: null, physicalCoverageDays: null,
  });
  assert.deepEqual(notReady, []);
});

test("no sales never creates coverage-based replenishment", () => {
  assert.equal(calculateCoverageDays(100, 0, true), null);
  const alerts = buildReplenishmentAlerts({
    sourceSku: "SKU-1", brand: "NACIONAL", physicalReady: true, physicalAvailable: 100,
    unitsSold30: 0, avgDailySales30: 0, salesVelocityReady: true, physicalCoverageDays: null,
    fullAccounts: [],
  });
  assert.ok(!alerts.some((alert) => alert.alertType.startsWith("PURCHASE_")));
});

test("manual inventory links win and automatic retry is deterministic", () => {
  const manual = { sourceSkuKey: "MANUAL", priority: 99, linkMethod: "manual" };
  const candidates = [
    { sourceSkuKey: "13014", priority: 2, linkMethod: "ml_item_relationship" },
    { sourceSkuKey: "13014", priority: 1, linkMethod: "exact_sku" },
  ];
  assert.deepEqual(chooseInventoryLink(manual, candidates), { status: "manual", selected: manual });
  const first = chooseInventoryLink(null, candidates);
  const retry = chooseInventoryLink(null, [...candidates].reverse());
  assert.deepEqual(retry, first);
  assert.equal(first.selected?.linkMethod, "exact_sku");
});
