import assert from "node:assert/strict";
import { test } from "node:test";

import type { Evidence } from "./product-diagnostic-domain";
import type { AnthropicMessagesAdapter } from "./run-product-diagnostic-v2";
import { runProductDiagnosticV2 } from "./run-product-diagnostic-v2";

const SAMPLE_EVIDENCE: Evidence[] = [
  { id: "sales.last7.units", category: "sales", label: "Unidades (7 dias)", value: 5, displayText: "5 unidades", occurredAt: null, source: "daily_product_metrics" },
  { id: "market.gmr.MLB123.price_to_win", category: "price", label: "Price to win", value: 106.9, displayText: "Price to win: 106,90", occurredAt: "2026-08-19T00:00:00Z", source: "ml_price_to_win" },
];

function mockAdapter(handler: AnthropicMessagesAdapter["create"]): AnthropicMessagesAdapter {
  return { create: handler };
}

function baseResult(overrides: Record<string, unknown> = {}) {
  return {
    verdict: "sales_drop",
    context: "Sem vendas ha 30 dias apesar de estoque disponivel.",
    primaryCause: { category: "PRICE_NOT_COMPETITIVE", title: "Preco acima do mercado na GMR", explanation: "Preco atual acima do price to win.", confidence: "high", evidenceRefs: ["market.gmr.MLB123.price_to_win"] },
    secondaryHypotheses: [],
    marketAssessment: { status: "competing", summary: "Perdendo para concorrentes mais baratos.", evidenceRefs: ["market.gmr.MLB123.price_to_win"] },
    actions: [{ priority: "high", actionCode: "ADJUST_PRICE", scope: { type: "listing", accountCode: "gmr", itemId: "MLB123" }, title: "Ajustar preco GMR", instruction: "Reduzir para R$106,90.", suggestedValue: "106.90", reason: "Alinha com price to win.", evidenceRefs: ["market.gmr.MLB123.price_to_win"] }],
    limitations: [],
    ...overrides,
  };
}

async function callWith(result: Record<string, unknown>) {
  const client = mockAdapter(async () => ({
    id: "msg_v2",
    content: [{ type: "text", text: JSON.stringify(result) }],
    usage: { input_tokens: 800, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }));
  return runProductDiagnosticV2({ evidence: SAMPLE_EVIDENCE, product: { sku: "13014", name: "Farol" }, asOfDate: "2026-08-18", trigger: "SALES_DROP_7D", model: "claude-sonnet-5", client });
}

// 1. diagnostic v2 output máximo 2 hypotheses
test("secondaryHypotheses is truncated to at most 2, even if Claude returns more", async () => {
  const outcome = await callWith(baseResult({
    secondaryHypotheses: [
      { title: "h1", explanation: "e1", confidence: "low", evidenceRefs: [], missingEvidence: [] },
      { title: "h2", explanation: "e2", confidence: "low", evidenceRefs: [], missingEvidence: [] },
      { title: "h3", explanation: "e3", confidence: "low", evidenceRefs: [], missingEvidence: [] },
    ],
  }));
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.result.secondaryHypotheses.length, 2);
});

// 2. máximo 4 actions
test("actions is truncated to at most 4, even if Claude returns more", async () => {
  const action = baseResult().actions[0];
  const outcome = await callWith(baseResult({ actions: [action, action, action, action, action] }));
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.result.actions.length, 4);
});

// 3. primaryCause direta
test("a well-supported primaryCause passes through with its category and confidence intact", async () => {
  const outcome = await callWith(baseResult());
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.result.primaryCause?.category, "PRICE_NOT_COMPETITIVE");
    assert.equal(outcome.result.primaryCause?.confidence, "high");
  }
});

// 4. não repete mesma causa em 3 blocos — this is a prompt-level instruction (tested via the system prompt content, not a parseable server-side property); verify the terse-writing rule is actually present in the shipped system prompt.
test("the v2 system prompt instructs against repeating the same fact across context/cause/action", async () => {
  const { PRODUCT_DIAGNOSTIC_SYSTEM_PROMPT_V2 } = await import("./product-diagnostic-prompt-v2");
  assert.match(PRODUCT_DIAGNOSTIC_SYSTEM_PROMPT_V2, /nao repita/i);
});

// primaryCause can be null (UNKNOWN case handled by category, not by omission) — sanity check limits still apply
test("context is truncated to the character cap", async () => {
  const longContext = "a".repeat(1000);
  const outcome = await callWith(baseResult({ context: longContext }));
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.ok(outcome.result.context.length <= 400);
});

// 11/12. targetPrice nunca inventado — deve apontar evidencia monetária válida
test("an ADJUST_PRICE suggestedValue matching a real price_to_win evidence value is accepted", async () => {
  const outcome = await callWith(baseResult());
  assert.equal(outcome.ok, true);
});

test("an ADJUST_PRICE suggestedValue with an invented price is rejected", async () => {
  const action = { ...baseResult().actions[0], suggestedValue: "199.90" };
  const outcome = await callWith(baseResult({ actions: [action] }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.errorCode, "INVALID_PRICE_TARGET");
});

test("an ADJUST_PRICE action with suggestedValue=null is accepted without a price-target check", async () => {
  const action = { ...baseResult().actions[0], suggestedValue: null };
  const outcome = await callWith(baseResult({ actions: [action] }));
  assert.equal(outcome.ok, true);
});

test("a reference to a nonexistent evidence id is rejected", async () => {
  const outcome = await callWith(baseResult({ marketAssessment: { status: "competing", summary: "x", evidenceRefs: ["market.does_not_exist"] } }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.errorCode, "INVALID_EVIDENCE_REFERENCE");
});

test("a missing Anthropic client resolves gracefully instead of throwing", async () => {
  const outcome = await runProductDiagnosticV2({ evidence: SAMPLE_EVIDENCE, product: { sku: "13014", name: "Farol" }, asOfDate: "2026-08-18", trigger: "SALES_DROP_7D", model: "claude-sonnet-5", client: null });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.errorCode, "ANTHROPIC_NOT_CONFIGURED");
});

// 17. catalog-controlled title => não recomendar título impossível (regra do prompt)
test("the v2 system prompt instructs against recommending an impossible title/image change on catalog-controlled content", async () => {
  const { PRODUCT_DIAGNOSTIC_SYSTEM_PROMPT_V2 } = await import("./product-diagnostic-prompt-v2");
  assert.match(PRODUCT_DIAGNOSTIC_SYSTEM_PROMPT_V2, /editavel/i);
});

// 18/19. editable title + evidence => suggested title permitido, mas nunca inventa atributos
test("the v2 system prompt instructs that a suggested title may only use attributes already proven by evidence", async () => {
  const { PRODUCT_DIAGNOSTIC_SYSTEM_PROMPT_V2 } = await import("./product-diagnostic-prompt-v2");
  assert.match(PRODUCT_DIAGNOSTIC_SYSTEM_PROMPT_V2, /nunca invente compatibilidade/i);
});
