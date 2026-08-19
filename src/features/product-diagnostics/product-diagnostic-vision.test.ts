import assert from "node:assert/strict";
import { test } from "node:test";

import { buildVisionEvidence } from "./product-diagnostic-vision";

test("buildVisionEvidence never claims a conversion/sales impact, only a qualitative note", () => {
  const evidence = buildVisionEvidence({
    images: [{ accountCode: "gmr", itemId: "MLB1", clarity: "poor", framing: "poor", background: "busy", weakerThanReferences: true, notes: "Produto ocupa pouco espaco no quadro." }],
  });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].id, "vision.gmr.MLB1.assessment");
  assert.doesNotMatch(evidence[0].displayText, /%|reduz.*vendas/i);
});

test("buildVisionEvidence ids stay unique even for duplicate account/item pairs", () => {
  const evidence = buildVisionEvidence({
    images: [
      { accountCode: "gmr", itemId: "MLB1", clarity: "good", framing: "good", background: "clean", weakerThanReferences: false, notes: "ok" },
      { accountCode: "gmr", itemId: "MLB1", clarity: "fair", framing: "fair", background: "clean", weakerThanReferences: false, notes: "duplicate" },
    ],
  });
  const ids = evidence.map((item) => item.id);
  assert.equal(ids.length, new Set(ids).size);
});
