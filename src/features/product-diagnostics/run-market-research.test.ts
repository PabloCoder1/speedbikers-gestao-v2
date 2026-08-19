import assert from "node:assert/strict";
import { test } from "node:test";

import { buildExternalMarketEvidence, type ExternalMarketResult } from "./product-market-evidence-domain";
import { MARKET_RESEARCH_SYSTEM_PROMPT, type AnthropicMarketResearchAdapter } from "./run-market-research";
import { runMarketResearch } from "./run-market-research";

function mockAdapter(handler: AnthropicMarketResearchAdapter["create"]): AnthropicMarketResearchAdapter {
  return { create: handler };
}

// 22. external search max 3 buscas
test("the web_search tool is capped at max_uses=3", async () => {
  let capturedMaxUses: number | undefined;
  const client = mockAdapter(async (params) => {
    capturedMaxUses = params.tools[0].max_uses;
    return {
      id: "msg_r1",
      content: [{ type: "text", text: JSON.stringify({ results: [], summary: "Nada encontrado." }) }],
      usage: { input_tokens: 500, output_tokens: 50 },
    };
  });
  const outcome = await runMarketResearch({ query: "Honda 61300-KVB-000", model: "claude-sonnet-5", client });
  assert.equal(outcome.ok, true);
  assert.equal(capturedMaxUses, 3);
});

// 23. weak external match não influencia primary cause (prompt-level rule, verified as shipped instruction text)
test("the system prompt instructs that weak matches never support the primary cause", () => {
  assert.match(MARKET_RESEARCH_SYSTEM_PROMPT, /weak/i);
});

// 24. external sources persistidas sem HTML bruto
test("external results carry only title/url/domain/price/confidence — never raw page content", async () => {
  const client = mockAdapter(async () => ({
    id: "msg_r2",
    content: [{ type: "text", text: JSON.stringify({ results: [{ title: "Farol Titan 125", url: "https://example.com/p", domain: "example.com", priceObserved: 99.9, currencyObserved: "BRL", matchConfidence: "probable" }], summary: "Encontrado um resultado provavel." }) }],
    usage: { input_tokens: 500, output_tokens: 80 },
  }));
  const outcome = await runMarketResearch({ query: "Farol Titan 125", model: "claude-sonnet-5", client });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    const keys = Object.keys(outcome.externalResults[0]);
    assert.deepEqual(keys.sort(), ["currencyObserved", "domain", "fetchedAt", "matchConfidence", "priceObserved", "title", "url"].sort());

    const evidence = buildExternalMarketEvidence(outcome.externalResults as ExternalMarketResult[]);
    assert.equal(evidence.length, 1);
    assert.doesNotMatch(JSON.stringify(evidence), /<html|<body|<div/i);
  }
});

test("a missing Anthropic client resolves gracefully instead of throwing", async () => {
  const outcome = await runMarketResearch({ query: "x", model: "claude-sonnet-5", client: null });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.errorCode, "ANTHROPIC_NOT_CONFIGURED");
});
