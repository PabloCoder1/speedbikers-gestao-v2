import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// 30. UI load nunca chama market/Claude automaticamente — static guard against
// /produto's page.tsx importing anything that fetches live market data or
// calls Anthropic at render time (only the cheap V1-only evidence rebuild,
// used for the staleness signal, is allowed there).
test("/produto page.tsx never imports the Claude-calling or live-market-fetching modules", () => {
  const source = readFileSync(join(__dirname, "..", "..", "app", "(dashboard)", "produto", "[productId]", "page.tsx"), "utf8");
  for (const forbidden of [
    "run-product-diagnostic-v2",
    "run-product-diagnostic\"",
    "run-market-research",
    "run-vision-assessment",
    "fetch-official-market-data",
    "fetch-external-market-research",
    "fetch-vision-assessment-for-product",
    "build-product-diagnostic-evidence-v2",
  ]) {
    assert.ok(!source.includes(forbidden), `page.tsx must never import "${forbidden}"`);
  }
});
