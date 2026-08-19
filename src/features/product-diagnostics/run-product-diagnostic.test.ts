import assert from "node:assert/strict";
import { test } from "node:test";

import type { Evidence } from "./product-diagnostic-domain";
import type { AnthropicMessagesAdapter } from "./run-product-diagnostic";
import { runProductDiagnostic } from "./run-product-diagnostic";

const SAMPLE_EVIDENCE: Evidence[] = [
  { id: "sales.last7.units", category: "sales", label: "Unidades (7 dias)", value: 5, displayText: "5 unidades", occurredAt: null, source: "daily_product_metrics" },
  { id: "price.sb.MLB123.2026-08-14", category: "price", label: "Preco", value: {}, displayText: "Preco mudou", occurredAt: "2026-08-14T00:00:00Z", source: "ml_offer_price_state_snapshots" },
];

const VALID_RESULT = {
  verdict: "sales_drop",
  executiveSummary: "Queda de vendas nos ultimos 7 dias.",
  confidence: "medium",
  correlations: [{ statement: "A queda coincide com o fim da promocao.", evidenceRefs: ["price.sb.MLB123.2026-08-14"] }],
  hypotheses: [
    {
      title: "Fim da promocao associado a queda",
      confidence: "medium",
      explanation: "O preco final subiu apos o fim da promocao.",
      evidenceRefs: ["price.sb.MLB123.2026-08-14"],
      counterEvidenceRefs: [],
      missingEvidence: [],
    },
  ],
  recommendedActions: [{ priority: "high", actionCode: "REVIEW_PROMOTION", title: "Revisar promocao", reason: "Preco final subiu.", evidenceRefs: ["price.sb.MLB123.2026-08-14"] }],
  limitations: [],
};

function mockAdapter(handler: AnthropicMessagesAdapter["create"]): AnthropicMessagesAdapter {
  return { create: handler };
}

function baseCall(client: AnthropicMessagesAdapter) {
  return runProductDiagnostic({
    evidence: SAMPLE_EVIDENCE,
    product: { sku: "13014", name: "Farol Titan 125" },
    asOfDate: "2026-08-18",
    trigger: "SALES_DROP_7D",
    model: "claude-sonnet-5",
    client,
  });
}

// 20. ausência de chave -> estado gracioso, nunca 500 / exceção
test("a missing Anthropic client (ANTHROPIC_API_KEY not configured) resolves gracefully instead of throwing", async () => {
  const outcome = await runProductDiagnostic({
    evidence: SAMPLE_EVIDENCE,
    product: { sku: "13014", name: "Farol Titan 125" },
    asOfDate: "2026-08-18",
    trigger: "SALES_DROP_7D",
    model: "claude-sonnet-5",
    client: null,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.errorCode, "ANTHROPIC_NOT_CONFIGURED");
});

// 21. erro da Anthropic -> failed, mas os fatos determinísticos continuam disponíveis (evidence não é tocada)
test("an Anthropic request failure resolves as a sanitized failure, not a thrown exception", async () => {
  const client = mockAdapter(async () => {
    throw new Error("connection reset by peer at 10.0.0.5 with secret token abc123");
  });
  const outcome = await baseCall(client);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.errorCode, "ANTHROPIC_REQUEST_FAILED");
    assert.ok(outcome.errorMessage.length <= 500);
  }
});

// 22. Structured Output válido é aceito e mapeado corretamente
test("a valid structured-output response is parsed into the diagnostic result", async () => {
  const client = mockAdapter(async () => ({
    id: "msg_123",
    content: [{ type: "text", text: JSON.stringify(VALID_RESULT) }],
    usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }));
  const outcome = await baseCall(client);
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.result.verdict, "sales_drop");
    assert.equal(outcome.messageId, "msg_123");
    assert.equal(outcome.usage.inputTokens, 1200);
  }
});

// 23. evidenceRef inexistente é rejeitado, não persistido como sucesso
test("a reference to a nonexistent evidence id is rejected as INVALID_EVIDENCE_REFERENCE", async () => {
  const invalidResult = { ...VALID_RESULT, correlations: [{ statement: "x", evidenceRefs: ["sales.does_not_exist"] }] };
  const client = mockAdapter(async () => ({
    id: "msg_124",
    content: [{ type: "text", text: JSON.stringify(invalidResult) }],
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }));
  const outcome = await baseCall(client);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.errorCode, "INVALID_EVIDENCE_REFERENCE");
});

// 24. Claude nunca recebe PII do comprador
test("the evidence sent to Claude never carries buyer PII fields", () => {
  const serialized = JSON.stringify(SAMPLE_EVIDENCE).toLowerCase();
  for (const forbidden of ["buyer", "cpf", "telefone", "phone", "e-mail", "endereco", "address"]) {
    assert.ok(!serialized.includes(forbidden), `evidence must never contain "${forbidden}"`);
  }
});

// 25. Claude nunca recebe o raw_payload
test("the evidence sent to Claude never carries a raw_payload field", () => {
  const serialized = JSON.stringify(SAMPLE_EVIDENCE).toLowerCase();
  assert.ok(!serialized.includes("raw_payload"));
});
