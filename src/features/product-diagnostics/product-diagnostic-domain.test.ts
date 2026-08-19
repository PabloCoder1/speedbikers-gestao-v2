import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildProductDiagnosticEvidence,
  classifySalesTrigger,
  computeDeltaPercentage,
  detectAccountSpecificDropCodes,
  resolveDiagnosticCacheDecision,
  resolveProductDiagnosticAsOfDate,
  type ProductDiagnosticRawFacts,
} from "./product-diagnostic-domain";

function baseRawFacts(overrides: Partial<ProductDiagnosticRawFacts> = {}): ProductDiagnosticRawFacts {
  return {
    asOfDate: "2026-08-18",
    product: { id: "product-1", sku: "13014", name: "Farol Titan 125" },
    sales: {
      units7: 10,
      previousUnits7: 10,
      revenue7: 100,
      previousRevenue7: 100,
      orders7: 10,
      previousOrders7: 10,
      units30: 40,
      previousUnits30: 40,
      revenue30: 400,
      previousRevenue30: 400,
      orders30: 40,
      previousOrders30: 40,
      units90: 120,
      daysWithSales7: 7,
      daysWithSales30: 30,
      lastSaleDate: "2026-08-18",
    },
    salesByAccount: [],
    salesCoverageReady: true,
    salesCoverageFrom: "2026-05-21",
    salesCoverageTo: "2026-08-18",
    priceEvents: [],
    promotionEvents: [],
    priceHistoryFrom: null,
    priceHistoryTo: null,
    priceCheckedAt: null,
    fullEvents: [],
    fullHistoryFrom: null,
    fullHistoryTo: null,
    fullCurrent: { applicable: true, ready: true, available: 10, total: 10, coverageDays: 5, checkedAt: "2026-08-18T10:00:00Z" },
    physicalCurrent: { applicable: true, ready: true, available: 100, current: 100, coverageDays: 10, checkedAt: "2026-08-18T09:00:00Z" },
    advertised: { listingCount: 4, activeListingCount: 4 },
    mappingStatus: "linked",
    planning: { suggestedPurchaseQuantity: 0, purchasePlanningStatus: "covered", coverageDays: 10, leadTimeDays: 15 },
    alerts: [],
    openPurchaseOrders: [],
    accountCodeByMlAccountId: {},
    ...overrides,
  };
}

// 1. last7 vs previous7 correto
test("delta percentage compares last7 to previous7 correctly", () => {
  assert.equal(computeDeltaPercentage(70, 100), -30);
  assert.equal(computeDeltaPercentage(130, 100), 30);
});

// 2. dia parcial atual é excluído (as_of_date nunca é hoje)
test("as_of_date is always the last complete day, never today", () => {
  assert.equal(resolveProductDiagnosticAsOfDate("2026-08-19"), "2026-08-18");
  assert.notEqual(resolveProductDiagnosticAsOfDate("2026-08-19"), "2026-08-19");
});

// 3. previous = 0 não produz divisão inválida
test("previous = 0 never divides — returns null instead of Infinity", () => {
  assert.equal(computeDeltaPercentage(10, 0), null);
  assert.equal(computeDeltaPercentage(0, 0), null);
});

// 4. NO_SALES_7D
test("classifies NO_SALES_7D when current7 is zero and previous7 had sales", () => {
  const trigger = classifySalesTrigger({ units7: 0, previousUnits7: 5, units30: 20, previousUnits30: 20, salesCoverageReady: true });
  assert.equal(trigger, "NO_SALES_7D");
});

// 5. SALES_DROP_7D
test("classifies SALES_DROP_7D on a >=30% drop with previous7 >= 3", () => {
  const trigger = classifySalesTrigger({ units7: 3, previousUnits7: 10, units30: 40, previousUnits30: 40, salesCoverageReady: true });
  assert.equal(trigger, "SALES_DROP_7D");
});

// 6. queda em uma única conta gera evidência de conta específica
test("a drop concentrated in one account is flagged as account-specific, not product-wide", () => {
  const accounts = [
    { mlAccountId: "a1", accountCode: "speedbikers", accountDisplayName: "SpeedBikers", units7: 2, previousUnits7: 10, units30: 10, previousUnits30: 40, revenue30: 100, orders30: 10 },
    { mlAccountId: "a2", accountCode: "gmr", accountDisplayName: "GMR", units7: 20, previousUnits7: 18, units30: 80, previousUnits30: 70, revenue30: 800, orders30: 80 },
  ];
  const codes = detectAccountSpecificDropCodes(accounts, "STABLE");
  assert.deepEqual(codes, ["speedbikers"]);

  const built = buildProductDiagnosticEvidence(baseRawFacts({ salesByAccount: accounts }));
  const flag = built.evidence.find((item) => item.id === "sales.account_specific_drop");
  assert.ok(flag, "expected an account_specific_drop evidence item");
  assert.match(flag!.displayText, /speedbikers/);
});

// 7. evento de aumento de preço
test("a price increase event becomes PRICE_EFFECTIVE_CHANGED evidence", () => {
  const raw = baseRawFacts({
    priceEvents: [{ type: "PRICE_EFFECTIVE_CHANGED", occurredAt: "2026-08-14T10:00:00Z", mlAccountId: "a1", itemId: "MLB123", before: 35.9, after: 39.9, percentageChange: 11.14 }],
    accountCodeByMlAccountId: { a1: "sb" },
  });
  const built = buildProductDiagnosticEvidence(raw);
  const priceEvidence = built.evidence.find((item) => item.category === "price");
  assert.ok(priceEvidence);
  assert.equal(priceEvidence!.id, "price.sb.MLB123.2026-08-14");
  assert.match(priceEvidence!.displayText, /35,90/);
  assert.match(priceEvidence!.displayText, /39,90/);
});

// 8. promoção encerrada
test("a promotion transition to inactive becomes a PROMOTION_ENDED evidence", () => {
  const raw = baseRawFacts({
    promotionEvents: [{ type: "PROMOTION_ENDED", occurredAt: "2026-08-12T03:00:00Z", mlAccountId: "a1", itemId: "MLB123", promotionId: null, promotionName: null, promotionStatus: "ended", promotionStartedAt: null, promotionEndsAt: null }],
    accountCodeByMlAccountId: { a1: "sb" },
  });
  const built = buildProductDiagnosticEvidence(raw);
  const promotionEvidence = built.evidence.find((item) => item.category === "promotion");
  assert.ok(promotionEvidence);
  assert.match(promotionEvidence!.displayText, /encerrada/);
});

// 9. Full atual zero SEM histórico não inventa data de ruptura
test("Full current zero without history never invents a rupture date", () => {
  const raw = baseRawFacts({
    fullCurrent: { applicable: true, ready: true, available: 0, total: 0, coverageDays: 0, checkedAt: "2026-08-18T10:00:00Z" },
    fullEvents: [],
  });
  const built = buildProductDiagnosticEvidence(raw);
  const fullEvidence = built.evidence.find((item) => item.id === "full.current.available");
  assert.ok(fullEvidence);
  assert.equal(fullEvidence!.occurredAt, "2026-08-18T10:00:00Z");
  assert.doesNotMatch(fullEvidence!.displayText, /zerou em/i);
  assert.equal(built.evidence.some((item) => item.category === "full" && item.id !== "full.current.available"), false);
});

// 10. snapshot de Full provando queda a zero gera FULL_ZERO
test("a proven Full snapshot transition to zero generates FULL_ZERO evidence", () => {
  const raw = baseRawFacts({
    fullEvents: [{ type: "FULL_ZERO", occurredAt: "2026-08-18T15:00:00Z", mlAccountId: "a1", inventoryId: "INV1", before: 1, after: 0 }],
    accountCodeByMlAccountId: { a1: "gmr" },
  });
  const built = buildProductDiagnosticEvidence(raw);
  const zeroEvent = built.evidence.find((item) => item.id.startsWith("full.gmr.INV1.full_zero"));
  assert.ok(zeroEvent, "expected a FULL_ZERO evidence item");
});

// 11. estoque físico zero
test("physical stock at zero is surfaced as a current fact", () => {
  const raw = baseRawFacts({ physicalCurrent: { applicable: true, ready: true, available: 0, current: 0, coverageDays: 0, checkedAt: "2026-08-18T09:00:00Z" } });
  const built = buildProductDiagnosticEvidence(raw);
  const stockEvidence = built.evidence.find((item) => item.id === "stock.physical.current");
  assert.ok(stockEvidence);
  assert.equal(stockEvidence!.value, 0);
});

// 12. conflito de mapeamento
test("mapping conflict is surfaced as INVENTORY_MAPPING_CONFLICT", () => {
  const raw = baseRawFacts({ mappingStatus: "conflict" });
  const built = buildProductDiagnosticEvidence(raw);
  const mappingEvidence = built.evidence.find((item) => item.id === "mapping.status");
  assert.ok(mappingEvidence);
  assert.match(mappingEvidence!.displayText, /INVENTORY_MAPPING_CONFLICT/);
});

// 13. todos os anúncios inativos
test("all listings inactive produces an ALL_OFFERS_INACTIVE fact", () => {
  const raw = baseRawFacts({ advertised: { listingCount: 3, activeListingCount: 0 } });
  const built = buildProductDiagnosticEvidence(raw);
  assert.ok(built.evidence.some((item) => item.id === "listing.all_offers_inactive"));
});

// 14. pedido de compra em trânsito
test("an open purchase order in transit is surfaced as evidence", () => {
  const raw = baseRawFacts({
    openPurchaseOrders: [{ purchaseOrderId: "po-1", orderNumber: "PC-000012", status: "ordered", expectedAt: "2026-08-25T00:00:00Z", quantityOrdered: 100, outstandingQuantity: 100 }],
  });
  const built = buildProductDiagnosticEvidence(raw);
  const poEvidence = built.evidence.find((item) => item.id === "purchase.open_order.PC-000012");
  assert.ok(poEvidence);
  assert.match(poEvidence!.displayText, /100 unidades em transito/);
});

// 15. IDs de evidência únicos
test("evidence ids are always unique, even when inputs collide", () => {
  const raw = baseRawFacts({
    alerts: [
      { alertType: "FULL_UNAVAILABLE_UNITS", severity: "info", suggestedActionCode: null, firstSeenAt: "2026-08-17T07:00:00Z", lastSeenAt: "2026-08-19T00:00:00Z" },
      { alertType: "FULL_UNAVAILABLE_UNITS", severity: "info", suggestedActionCode: null, firstSeenAt: "2026-08-17T09:00:00Z", lastSeenAt: "2026-08-19T00:00:00Z" },
    ],
  });
  const built = buildProductDiagnosticEvidence(raw);
  const ids = built.evidence.map((item) => item.id);
  assert.equal(ids.length, new Set(ids).size);
  assert.ok(ids.includes("alert.FULL_UNAVAILABLE_UNITS.2026-08-17"));
  assert.ok(ids.includes("alert.FULL_UNAVAILABLE_UNITS.2026-08-17#2"));
});

// 16. hash de evidência determinístico
test("evidence hash is deterministic for identical input and changes when a fact changes", () => {
  const a = buildProductDiagnosticEvidence(baseRawFacts());
  const b = buildProductDiagnosticEvidence(baseRawFacts());
  assert.equal(a.evidenceHash, b.evidenceHash);

  const c = buildProductDiagnosticEvidence(baseRawFacts({ sales: { ...baseRawFacts().sales, units7: 999 } }));
  assert.notEqual(a.evidenceHash, c.evidenceHash);
});

// 17/18. decisão de cache
test("cache decision reuses a cached success unless force=true", () => {
  assert.equal(resolveDiagnosticCacheDecision({ hasCachedSuccess: true, force: false }), "use_cache");
  assert.equal(resolveDiagnosticCacheDecision({ hasCachedSuccess: true, force: true }), "call_anthropic");
  assert.equal(resolveDiagnosticCacheDecision({ hasCachedSuccess: false, force: false }), "call_anthropic");
});
