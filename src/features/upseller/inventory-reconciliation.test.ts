import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExactInventoryCandidate,
  decideInventoryReconciliation,
  shouldEnqueueInventoryReconciliation,
  type InventoryLinkCandidate,
} from "./inventory-reconciliation";

function relationshipCandidate(sourceSkuKey: string, priority = 4): InventoryLinkCandidate {
  return {
    sourceSku: sourceSkuKey,
    sourceSkuKey,
    sourceKind: "simple",
    linkMethod: priority === 2 ? "ml_item_relationship" : "ml_user_product_relationship",
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
    candidates: [relationshipCandidate("13014", 2), relationshipCandidate("1737")],
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
    candidates: [relationshipCandidate("13014"), relationshipCandidate("13014", 2)],
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
