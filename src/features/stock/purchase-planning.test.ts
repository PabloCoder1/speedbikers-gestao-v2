import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPhysicalDemand,
  calculatePurchaseRecommendation,
  purchaseLeadTimeDays,
} from "@/features/stock/stock-domain";

// ============================================================
// FÓRMULA DE COMPRA
// ============================================================

test("NAVETEC importado: 180 de demanda + 30 de reserva - 80 disponíveis = 130", () => {
  const result = calculatePurchaseRecommendation({
    physicalAvailable: 80,
    purchaseInTransit: 0,
    lowStockThreshold: 30,
    avgDailySales30: 2,
    salesVelocityReady: true,
    leadTimeDays: 90,
  });

  assert.equal(result.demandDuringLeadTime, 180);
  assert.equal(result.targetReserve, 30);
  assert.equal(result.suggestedPurchaseQuantity, 130);
  assert.equal(result.purchaseRequired, true);
  assert.equal(result.status, "due");
});

test("nacional com compra em trânsito cobrindo a necessidade sugere zero", () => {
  const result = calculatePurchaseRecommendation({
    physicalAvailable: 20,
    purchaseInTransit: 20,
    lowStockThreshold: 10,
    avgDailySales30: 2,
    salesVelocityReady: true,
    leadTimeDays: 15,
  });

  assert.equal(result.demandDuringLeadTime, 30);
  assert.equal(result.suggestedPurchaseQuantity, 0);
  assert.equal(result.purchaseRequired, false);
  assert.equal(result.status, "covered");
});

test("sem venda no periodo nao gera compra, mesmo com estoque zerado", () => {
  const result = calculatePurchaseRecommendation({
    physicalAvailable: 0,
    purchaseInTransit: 0,
    lowStockThreshold: 25,
    avgDailySales30: 0,
    salesVelocityReady: true,
    leadTimeDays: 15,
  });

  assert.equal(result.suggestedPurchaseQuantity, 0);
  assert.equal(result.status, "no_sales");
  assert.equal(result.reason, "no_recent_sales");
});

test("historico nao coberto devolve null em vez de extrapolar", () => {
  const result = calculatePurchaseRecommendation({
    physicalAvailable: 5,
    purchaseInTransit: 0,
    lowStockThreshold: 10,
    avgDailySales30: 4,
    salesVelocityReady: false,
    leadTimeDays: 15,
  });

  assert.equal(result.suggestedPurchaseQuantity, null);
  assert.equal(result.demandDuringLeadTime, null);
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.reason, "history_not_ready");
});

test("threshold ausente ou zero nao inventa reserva", () => {
  for (const threshold of [null, 0]) {
    const result = calculatePurchaseRecommendation({
      physicalAvailable: 10,
      purchaseInTransit: 0,
      lowStockThreshold: threshold,
      avgDailySales30: 1,
      salesVelocityReady: true,
      leadTimeDays: 15,
    });
    assert.equal(result.targetReserve, 0, `threshold ${threshold}`);
    // 15 de demanda - 10 disponiveis = 5, sem reserva somada.
    assert.equal(result.suggestedPurchaseQuantity, 5);
  }
});

test("threshold negativo e tratado como zero", () => {
  const result = calculatePurchaseRecommendation({
    physicalAvailable: 10,
    purchaseInTransit: 0,
    lowStockThreshold: -50,
    avgDailySales30: 1,
    salesVelocityReady: true,
    leadTimeDays: 15,
  });
  assert.equal(result.targetReserve, 0);
  assert.equal(result.suggestedPurchaseQuantity, 5);
});

test("projecao na chegada pode ser negativa e isso e informacao util", () => {
  const result = calculatePurchaseRecommendation({
    physicalAvailable: 20,
    purchaseInTransit: 0,
    lowStockThreshold: 0,
    avgDailySales30: 4,
    salesVelocityReady: true,
    leadTimeDays: 30,
  });

  assert.equal(result.demandDuringLeadTime, 120);
  assert.equal(result.projectedStockAtArrival, -100);
  assert.equal(result.suggestedPurchaseQuantity, 100);
});

test("resultado decimal e arredondado para cima", () => {
  const result = calculatePurchaseRecommendation({
    physicalAvailable: 0,
    purchaseInTransit: 0,
    lowStockThreshold: 0,
    avgDailySales30: 1 / 3,
    salesVelocityReady: true,
    leadTimeDays: 10,
  });

  // 10/3 = 3,333... precisa virar 4, nunca 3.
  assert.ok(
    Math.abs((result.demandDuringLeadTime ?? 0) - 10 / 3) < 1e-9,
    "a demanda é ~3,333 (comparada com tolerância: multiplicar e dividir dão bits diferentes)",
  );
  assert.equal(result.suggestedPurchaseQuantity, 4);
});

test("estoque zerado com venda ativa e urgente", () => {
  const result = calculatePurchaseRecommendation({
    physicalAvailable: 0,
    purchaseInTransit: 0,
    lowStockThreshold: 5,
    avgDailySales30: 3,
    salesVelocityReady: true,
    leadTimeDays: 15,
  });

  assert.equal(result.status, "urgent");
  assert.equal(result.suggestedPurchaseQuantity, 50);
});

test("vinculo fisico nao confiavel nao gera sugestao", () => {
  const result = calculatePurchaseRecommendation({
    physicalAvailable: 10,
    purchaseInTransit: 0,
    lowStockThreshold: 0,
    avgDailySales30: 2,
    salesVelocityReady: true,
    leadTimeDays: 15,
    mappingReliable: false,
  });

  assert.equal(result.suggestedPurchaseQuantity, null);
  assert.equal(result.status, "mapping_issue");
});

// ============================================================
// LEAD TIME
// ============================================================

test("marcas importadas usam 90 dias e as demais 15", () => {
  assert.equal(purchaseLeadTimeDays("OFF RACER"), 90);
  assert.equal(purchaseLeadTimeDays("OFFRACER"), 90);
  assert.equal(purchaseLeadTimeDays("NAVETEC"), 90);
  assert.equal(purchaseLeadTimeDays("off racer"), 90);
  assert.equal(purchaseLeadTimeDays("Navetec"), 90);

  assert.equal(purchaseLeadTimeDays("PRO TORK"), 15);
  assert.equal(purchaseLeadTimeDays("IMS"), 15);
  assert.equal(purchaseLeadTimeDays(null), 15);
  assert.equal(purchaseLeadTimeDays(""), 15);
});

// ============================================================
// ÁRVORE DE DEMANDA FÍSICA
// ============================================================

test("dois products simples no mesmo SKU fisico somam consumo", () => {
  const demand = buildPhysicalDemand(
    [
      { productId: "a", sourceSkuKey: "13014", sourceKind: "simple", unitsSold30: 100 },
      { productId: "b", sourceSkuKey: "13014", sourceKind: "simple", unitsSold30: 50 },
    ],
    [],
  );

  assert.equal(demand.length, 1, "o SKU fisico aparece uma unica vez");
  assert.equal(demand[0].sourceSkuKey, "13014");
  assert.equal(demand[0].physicalUnitsConsumed30, 150);
  assert.deepEqual(demand[0].contributingProductIds.sort(), ["a", "b"]);
});

test("kit distribui demanda entre componentes pela quantidade requerida", () => {
  const demand = buildPhysicalDemand(
    [{ productId: "kit-product", sourceSkuKey: "A.B", sourceKind: "kit", unitsSold30: 30 }],
    [
      {
        kitSkuKey: "A.B",
        reliable: true,
        components: [
          { skuKey: "A", requiredQuantity: 1 },
          { skuKey: "B", requiredQuantity: 2 },
        ],
      },
    ],
  );

  const byKey = new Map(demand.map((row) => [row.sourceSkuKey, row]));
  assert.equal(byKey.get("A")?.kitUnitsConsumed30, 30);
  assert.equal(byKey.get("B")?.kitUnitsConsumed30, 60);
  assert.equal(byKey.has("A.B"), false, "o kit nao vira linha de compra");
});

test("componente vendido direto soma com o consumo via kit", () => {
  const demand = buildPhysicalDemand(
    [
      { productId: "direto", sourceSkuKey: "A", sourceKind: "simple", unitsSold30: 50 },
      { productId: "kit-product", sourceSkuKey: "A.B", sourceKind: "kit", unitsSold30: 30 },
    ],
    [
      {
        kitSkuKey: "A.B",
        reliable: true,
        components: [
          { skuKey: "A", requiredQuantity: 1 },
          { skuKey: "B", requiredQuantity: 2 },
        ],
      },
    ],
  );

  const a = demand.find((row) => row.sourceSkuKey === "A");
  assert.equal(a?.directUnitsSold30, 50);
  assert.equal(a?.kitUnitsConsumed30, 30);
  assert.equal(a?.physicalUnitsConsumed30, 80);
});

test("kit sem composicao confiavel nao distribui demanda automaticamente", () => {
  const demand = buildPhysicalDemand(
    [{ productId: "kit-product", sourceSkuKey: "A.B", sourceKind: "kit", unitsSold30: 30 }],
    [{ kitSkuKey: "A.B", reliable: false, components: [{ skuKey: "A", requiredQuantity: 1 }] }],
  );

  const kitRow = demand.find((row) => row.sourceSkuKey === "A.B");
  assert.ok(kitRow, "o kit aparece para poder explicar o problema");
  assert.deepEqual(kitRow?.planningIssues, ["kit_components_unknown"]);
  assert.equal(kitRow?.physicalUnitsConsumed30, 0);
  assert.equal(
    demand.find((row) => row.sourceSkuKey === "A"),
    undefined,
    "nenhuma demanda foi inventada para o componente",
  );
});

test("kit desconhecido no mapa de kits tambem nao distribui", () => {
  const demand = buildPhysicalDemand(
    [{ productId: "kit-product", sourceSkuKey: "X.Y", sourceKind: "kit", unitsSold30: 10 }],
    [],
  );
  assert.deepEqual(demand[0].planningIssues, ["kit_components_unknown"]);
  assert.equal(demand[0].physicalUnitsConsumed30, 0);
});

test("o mesmo product nunca entra duas vezes na arvore", () => {
  const demand = buildPhysicalDemand(
    [
      { productId: "a", sourceSkuKey: "13014", sourceKind: "simple", unitsSold30: 100 },
      { productId: "a", sourceSkuKey: "13014", sourceKind: "simple", unitsSold30: 100 },
    ],
    [],
  );

  assert.equal(demand[0].physicalUnitsConsumed30, 100, "a duplicata foi ignorada");
  assert.deepEqual(demand[0].contributingProductIds, ["a"]);
});

test("kit e componente combinados preservam a contagem de products", () => {
  const demand = buildPhysicalDemand(
    [
      { productId: "p1", sourceSkuKey: "A", sourceKind: "simple", unitsSold30: 10 },
      { productId: "p2", sourceSkuKey: "A", sourceKind: "simple", unitsSold30: 5 },
      { productId: "p3", sourceSkuKey: "A.B", sourceKind: "kit", unitsSold30: 2 },
    ],
    [
      {
        kitSkuKey: "A.B",
        reliable: true,
        components: [
          { skuKey: "A", requiredQuantity: 3 },
          { skuKey: "B", requiredQuantity: 1 },
        ],
      },
    ],
  );

  const a = demand.find((row) => row.sourceSkuKey === "A");
  assert.equal(a?.directUnitsSold30, 15);
  assert.equal(a?.kitUnitsConsumed30, 6);
  assert.equal(a?.physicalUnitsConsumed30, 21);
  assert.deepEqual(a?.contributingProductIds.sort(), ["p1", "p2", "p3"]);
});
