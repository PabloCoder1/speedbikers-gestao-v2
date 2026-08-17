import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExactInventoryCandidate,
  buildMappedSkuCandidates,
  buildNormalizedSkuSuggestions,
  decideInventoryReconciliation,
  shouldEnqueueInventoryReconciliation,
  type InventoryLinkCandidate,
} from "./inventory-reconciliation";

const currentListing = [{ sellerSku: "SELLER-01", mlAccountId: "account-a", isCurrent: true, targetId: "listing-a" }];

function mappedRelationship({
  sourceSku = "PHYSICAL-01",
  sourceSkuKey = sourceSku,
  mappedListingSkuKey = "SELLER-01",
  mlAccountId = "account-a",
}: {
  sourceSku?: string;
  sourceSkuKey?: string;
  mappedListingSkuKey?: string;
  mlAccountId?: string;
} = {}) {
  return {
    sourceSku,
    sourceSkuKey,
    sourceKind: "simple" as const,
    mappedListingSkuKey,
    mlAccountId,
    channel: "mercado_livre",
    isCurrent: true,
  };
}

function relationshipCandidate(sourceSkuKey: string, priority = 5): InventoryLinkCandidate {
  return {
    sourceSku: sourceSkuKey,
    sourceSkuKey,
    sourceKind: "simple",
    linkMethod: priority === 3
      ? "ml_item_relationship"
      : priority === 4
        ? "ml_variation_relationship"
        : "ml_user_product_relationship",
    priority,
    evidenceKey: `relationship:${sourceSkuKey}`,
  };
}

test("unresolved dotted SKU with exact stock remains eligible for an exact simple link", () => {
  const candidate = buildExactInventoryCandidate({
    canonicalSku: "750.1211",
    canonicalSkuKey: "750.1211",
    hasStock: true,
    hasCatalog: true,
    kitDefinitionSource: null,
    unresolvedDotted: true,
  });

  assert.equal(candidate?.linkMethod, "exact_sku");
  assert.equal(candidate?.sourceKind, "simple");
});

test("explicit UpSeller kit produces a kit link", () => {
  const candidate = buildExactInventoryCandidate({
    canonicalSku: "A.B",
    canonicalSkuKey: "A.B",
    hasStock: true,
    hasCatalog: true,
    kitDefinitionSource: "upseller_export",
    unresolvedDotted: false,
  });

  assert.equal(candidate?.sourceKind, "kit");
});

test("fully validated derived dotted kit produces a kit link", () => {
  const candidate = buildExactInventoryCandidate({
    canonicalSku: "A.B",
    canonicalSkuKey: "A.B",
    hasStock: false,
    hasCatalog: true,
    kitDefinitionSource: "derived_dot",
    unresolvedDotted: false,
  });

  assert.equal(candidate?.sourceKind, "kit");
});

test("unresolved dotted SKU without a direct current source stays missing", () => {
  const exact = buildExactInventoryCandidate({
    canonicalSku: "1057.",
    canonicalSkuKey: "1057.",
    hasStock: false,
    hasCatalog: false,
    kitDefinitionSource: null,
    unresolvedDotted: true,
  });

  assert.equal(exact, null);
  assert.equal(decideInventoryReconciliation({ manualLinkActive: false, candidates: [] }).status, "missing");
});

test("exact and MLBU evidence for the same physical SKU do not conflict", () => {
  const exact = buildExactInventoryCandidate({
    canonicalSku: "13014",
    canonicalSkuKey: "13014",
    hasStock: true,
    hasCatalog: true,
    kitDefinitionSource: null,
    unresolvedDotted: false,
  })!;
  const decision = decideInventoryReconciliation({
    manualLinkActive: false,
    candidates: [relationshipCandidate("13014"), exact],
  });

  assert.equal(decision.status, "linked");
  if (decision.status === "linked") assert.equal(decision.candidate.linkMethod, "exact_sku");
});

test("exact and MLBU evidence for different physical SKUs remains a conflict", () => {
  const exact = buildExactInventoryCandidate({
    canonicalSku: "13014",
    canonicalSkuKey: "13014",
    hasStock: true,
    hasCatalog: true,
    kitDefinitionSource: null,
    unresolvedDotted: false,
  })!;
  const decision = decideInventoryReconciliation({
    manualLinkActive: false,
    candidates: [exact, relationshipCandidate("1737")],
  });

  assert.equal(decision.status, "conflict");
  if (decision.status === "conflict") assert.deepEqual(decision.sourceSkuKeys, ["13014", "1737"]);
});

test("an active manual link is never replaced", () => {
  const decision = decideInventoryReconciliation({
    manualLinkActive: true,
    candidates: [relationshipCandidate("13014", 3), relationshipCandidate("1737")],
  });

  assert.equal(decision.status, "manual");
});

test("new products and only SKU-changing updates enqueue reconciliation", () => {
  assert.equal(shouldEnqueueInventoryReconciliation({
    operation: "insert", newSku: "Off005-9", newSkuKey: "OFF005-9",
  }), true);
  assert.equal(shouldEnqueueInventoryReconciliation({
    operation: "update", oldSku: "A", newSku: "A", oldSkuKey: "A", newSkuKey: "A",
  }), false);
  assert.equal(shouldEnqueueInventoryReconciliation({
    operation: "update", oldSku: "A", newSku: "B", oldSkuKey: "A", newSkuKey: "B",
  }), true);
});

test("reconciliation retries are deterministic and idempotent", () => {
  const input = {
    manualLinkActive: false,
    candidates: [relationshipCandidate("13014"), relationshipCandidate("13014", 3)],
  };

  assert.deepEqual(decideInventoryReconciliation(input), decideInventoryReconciliation(input));
});

test("750.1211 fixture links to its own direct SKU while retaining simple stock semantics", () => {
  const candidate = buildExactInventoryCandidate({
    canonicalSku: "750.1211",
    canonicalSkuKey: "750.1211",
    hasStock: true,
    hasCatalog: true,
    kitDefinitionSource: null,
    unresolvedDotted: true,
  })!;
  const decision = decideInventoryReconciliation({ manualLinkActive: false, candidates: [candidate] });

  assert.equal(decision.status, "linked");
  if (decision.status === "linked") {
    assert.equal(decision.candidate.sourceSkuKey, "750.1211");
    assert.equal(decision.candidate.sourceKind, "simple");
  }
});

test("261 variants without exact or relationship evidence are not auto-linked", () => {
  for (const sku of ["261-MENA-B", "261MENAB"]) {
    const candidate = buildExactInventoryCandidate({
      canonicalSku: sku,
      canonicalSkuKey: sku,
      hasStock: false,
      hasCatalog: false,
      kitDefinitionSource: null,
      unresolvedDotted: false,
    });
    assert.equal(candidate, null);
    assert.equal(decideInventoryReconciliation({ manualLinkActive: false, candidates: [] }).status, "missing");
  }
});

test("a unique mapped listing SKU becomes a deterministic link", () => {
  const candidates = buildMappedSkuCandidates({
    productSkuKey: "CANONICAL-01",
    listings: currentListing,
    variations: [],
    relationships: [mappedRelationship()],
  });
  const decision = decideInventoryReconciliation({ manualLinkActive: false, candidates });

  assert.equal(decision.status, "linked");
  if (decision.status === "linked") {
    assert.equal(decision.candidate.sourceSkuKey, "PHYSICAL-01");
    assert.equal(decision.candidate.linkMethod, "mapped_listing_sku_relationship");
  }
});

test("200501+Parafusos maps explicitly to physical SKU 200501.993", () => {
  const candidates = buildMappedSkuCandidates({
    productSkuKey: "200501+PARAFUSOS",
    listings: [],
    variations: [],
    relationships: [mappedRelationship({
      sourceSku: "200501.993",
      mappedListingSkuKey: "200501+PARAFUSOS",
    })],
  });
  const decision = decideInventoryReconciliation({ manualLinkActive: false, candidates });

  assert.equal(decision.status, "linked");
  if (decision.status === "linked") assert.equal(decision.candidate.sourceSku, "200501.993");
});

test("exact and mapped evidence for the same physical source do not conflict", () => {
  const exact = buildExactInventoryCandidate({
    canonicalSku: "PHYSICAL-01", canonicalSkuKey: "PHYSICAL-01",
    hasStock: true, hasCatalog: true, kitDefinitionSource: null, unresolvedDotted: false,
  })!;
  const mapped = buildMappedSkuCandidates({
    productSkuKey: "SELLER-01", listings: currentListing, variations: [],
    relationships: [mappedRelationship()],
  });

  const decision = decideInventoryReconciliation({ manualLinkActive: false, candidates: [exact, ...mapped] });
  assert.equal(decision.status, "linked");
  if (decision.status === "linked") assert.equal(decision.candidate.linkMethod, "exact_sku");
});

test("mapped and exact evidence for different physical sources remain a conflict", () => {
  const exact = buildExactInventoryCandidate({
    canonicalSku: "EXACT-01", canonicalSkuKey: "EXACT-01",
    hasStock: true, hasCatalog: true, kitDefinitionSource: null, unresolvedDotted: false,
  })!;
  const mapped = buildMappedSkuCandidates({
    productSkuKey: "SELLER-01", listings: currentListing, variations: [],
    relationships: [mappedRelationship()],
  });

  assert.equal(decideInventoryReconciliation({
    manualLinkActive: false, candidates: [exact, ...mapped],
  }).status, "conflict");
});

test("listing seller SKU ignores a mapped relationship from another account", () => {
  const candidates = buildMappedSkuCandidates({
    productSkuKey: "CANONICAL-01",
    listings: currentListing,
    variations: [],
    relationships: [mappedRelationship({ mlAccountId: "account-b" })],
  });

  assert.deepEqual(candidates, []);
});

test("variation seller SKU uses mapped evidence within its account", () => {
  const candidates = buildMappedSkuCandidates({
    productSkuKey: "CANONICAL-01",
    listings: [],
    variations: [{ sellerSku: " variation-01 ", mlAccountId: "account-a", isCurrent: true, targetId: "variation-a" }],
    relationships: [mappedRelationship({ mappedListingSkuKey: "VARIATION-01" })],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.evidenceKey, "variation_seller_sku:variation-a");
});

test("manual remains sovereign over mapped SKU evidence", () => {
  const candidates = buildMappedSkuCandidates({
    productSkuKey: "SELLER-01", listings: currentListing, variations: [],
    relationships: [mappedRelationship()],
  });

  assert.equal(decideInventoryReconciliation({ manualLinkActive: true, candidates }).status, "manual");
});

test("clearing a manual link allows deterministic reconciliation again", () => {
  const candidates = buildMappedSkuCandidates({
    productSkuKey: "SELLER-01", listings: currentListing, variations: [],
    relationships: [mappedRelationship()],
  });

  assert.equal(decideInventoryReconciliation({ manualLinkActive: true, candidates }).status, "manual");
  assert.equal(decideInventoryReconciliation({ manualLinkActive: false, candidates }).status, "linked");
});

test("normalized suggestions never become automatic links", () => {
  const candidates = buildMappedSkuCandidates({
    productSkuKey: "ABC123",
    listings: [],
    variations: [],
    relationships: [mappedRelationship({ mappedListingSkuKey: "ABC-123" })],
  });
  const suggestions = buildNormalizedSkuSuggestions({
    productSku: "ABC123",
    sources: [
      { sourceSku: "ABC-123", title: "Candidate A" },
      { sourceSku: "ABC.123", title: "Candidate B" },
      { sourceSku: "11014E", title: "Not the same key" },
    ],
  });

  assert.equal(decideInventoryReconciliation({ manualLinkActive: false, candidates }).status, "missing");
  assert.equal(suggestions.length, 2);
  assert.equal(suggestions.every((suggestion) => suggestion.ambiguous), true);
});
