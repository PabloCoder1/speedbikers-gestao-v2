import assert from "node:assert/strict";
import { test } from "node:test";

import { buildMarketResearchQuery, shouldTriggerExternalMarketResearch } from "./product-market-research-trigger";

// 21. external search só quando condition true
test("external search does not trigger when catalog/price-reference/internal data are all sufficient", () => {
  const trigger = shouldTriggerExternalMarketResearch({
    hasCatalogProductId: true,
    hasPriceReference: true,
    internalAndOfficialDataExplainDrop: true,
    userRequestedMarketResearch: false,
  });
  assert.equal(trigger, false);
});

test("external search triggers when the product has no catalog_product_id", () => {
  assert.equal(shouldTriggerExternalMarketResearch({ hasCatalogProductId: false, hasPriceReference: true, internalAndOfficialDataExplainDrop: true, userRequestedMarketResearch: false }), true);
});

test("external search triggers when there is no price reference", () => {
  assert.equal(shouldTriggerExternalMarketResearch({ hasCatalogProductId: true, hasPriceReference: false, internalAndOfficialDataExplainDrop: true, userRequestedMarketResearch: false }), true);
});

test("external search triggers when internal + official data don't explain the drop", () => {
  assert.equal(shouldTriggerExternalMarketResearch({ hasCatalogProductId: true, hasPriceReference: true, internalAndOfficialDataExplainDrop: false, userRequestedMarketResearch: false }), true);
});

test("external search always triggers on an explicit user request, regardless of other conditions", () => {
  assert.equal(shouldTriggerExternalMarketResearch({ hasCatalogProductId: true, hasPriceReference: true, internalAndOfficialDataExplainDrop: true, userRequestedMarketResearch: true }), true);
});

test("the query prefers strong identifiers over a bare generic name", () => {
  const query = buildMarketResearchQuery({
    brand: "Honda", partNumber: "61300-KVB-000", ean: null, sku: "13014", skuCommerciallySignificant: false,
    name: "Farol Cg Titan Fan 125 150 2000 A 2013 Completo C/ Lampada", compatibility: "CG 125/150 2000-2013",
  });
  assert.match(query, /Honda/);
  assert.match(query, /61300-KVB-000/);
  assert.doesNotMatch(query, /13014/);
});
