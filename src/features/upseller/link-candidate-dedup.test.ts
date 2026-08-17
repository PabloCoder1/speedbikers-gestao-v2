import assert from "node:assert/strict";
import test from "node:test";

import { deduplicateEquivalentLinkCandidates } from "./link-candidate-dedup";

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
