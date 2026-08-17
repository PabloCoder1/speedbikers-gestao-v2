import assert from "node:assert/strict";
import test from "node:test";

import {
  deduplicateEquivalentLinkCandidates,
  isMercadoLivreUserProductRelationship,
} from "./link-candidate-dedup";

test("equivalent relationship candidates become one deterministic candidate", () => {
  const candidates = deduplicateEquivalentLinkCandidates([
    {
      importId: "import-a",
      productId: "product-x",
      sourceSkuKey: "13014",
      linkMethod: "ml_item_relationship",
      relationshipRowNumber: 20,
      evidenceKey: "listing-b",
    },
    {
      importId: "import-a",
      productId: "product-x",
      sourceSkuKey: "13014",
      linkMethod: "ml_item_relationship",
      relationshipRowNumber: 10,
      evidenceKey: "listing-a",
    },
  ]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.relationshipRowNumber, 10);
  assert.equal(candidates[0]?.evidenceKey, "listing-a");
});

test("different physical SKUs for the same product remain separate candidates", () => {
  const candidates = deduplicateEquivalentLinkCandidates([
    {
      importId: "import-a",
      productId: "product-x",
      sourceSkuKey: "13014",
      linkMethod: "ml_item_relationship",
      relationshipRowNumber: 10,
      evidenceKey: "listing-a",
    },
    {
      importId: "import-a",
      productId: "product-x",
      sourceSkuKey: "1737",
      linkMethod: "ml_item_relationship",
      relationshipRowNumber: 11,
      evidenceKey: "listing-b",
    },
  ]);

  assert.deepEqual(candidates.map((candidate) => candidate.sourceSkuKey), ["13014", "1737"]);
});

test("equivalent listing and variation MLBU targets become one user-product candidate", () => {
  const candidates = deduplicateEquivalentLinkCandidates([
    {
      importId: "import-a",
      productId: "product-x",
      sourceSkuKey: "13014",
      linkMethod: "ml_user_product_relationship",
      relationshipRowNumber: 30,
      evidenceKey: "listing:MLBU123",
    },
    {
      importId: "import-a",
      productId: "product-x",
      sourceSkuKey: "13014",
      linkMethod: "ml_user_product_relationship",
      relationshipRowNumber: 30,
      evidenceKey: "variation:MLBU123",
    },
  ]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.evidenceKey, "listing:MLBU123");
});

test("the same MLBU keeps different physical SKU candidates separate", () => {
  const candidates = deduplicateEquivalentLinkCandidates([
    {
      importId: "import-a",
      productId: "product-x",
      sourceSkuKey: "13014",
      linkMethod: "ml_user_product_relationship",
      relationshipRowNumber: 30,
      evidenceKey: "listing:MLBU123",
    },
    {
      importId: "import-a",
      productId: "product-x",
      sourceSkuKey: "1737",
      linkMethod: "ml_user_product_relationship",
      relationshipRowNumber: 31,
      evidenceKey: "variation:MLBU123",
    },
  ]);

  assert.deepEqual(candidates.map((candidate) => candidate.sourceSkuKey), ["13014", "1737"]);
});

test("non-MLBU relationships are excluded from user-product linking", () => {
  assert.equal(isMercadoLivreUserProductRelationship({
    channel: "mercado_livre",
    listingExternalId: "MLBU123",
  }), true);
  assert.equal(isMercadoLivreUserProductRelationship({
    channel: "mercado_livre",
    listingExternalId: "MLB123",
  }), false);
  assert.equal(isMercadoLivreUserProductRelationship({
    channel: "shopee",
    listingExternalId: "MLBU123",
  }), false);
});
