/*
 * Free of `import "server-only"` — same reasoning as
 * run-product-diagnostic.ts: the Anthropic client is injected by the
 * caller, so this stays importable by node:test.
 */
import type { Evidence } from "@/features/product-diagnostics/product-diagnostic-domain";
import {
  PRODUCT_DIAGNOSTIC_PROMPT_VERSION_V2,
  PRODUCT_DIAGNOSTIC_SYSTEM_PROMPT_V2,
  buildProductDiagnosticUserMessageV2,
} from "@/features/product-diagnostics/product-diagnostic-prompt-v2";
import {
  PRODUCT_DIAGNOSTIC_V2_LIMITS,
  PRODUCT_DIAGNOSTIC_V2_RESULT_JSON_SCHEMA,
  type ProductDiagnosticResultV2,
} from "@/features/product-diagnostics/product-diagnostic-schema-v2";
import { prepareAnthropicStructuredOutputSchema } from "@/integrations/anthropic/prepare-structured-output-schema";

const PREPARED_SCHEMA = prepareAnthropicStructuredOutputSchema(PRODUCT_DIAGNOSTIC_V2_RESULT_JSON_SCHEMA);

export type AnthropicMessagesAdapter = {
  create: (params: {
    model: string;
    max_tokens: number;
    system: string;
    messages: Array<{ role: "user"; content: string }>;
    output_config: { effort: "medium"; format: { type: "json_schema"; schema: Record<string, unknown> } };
  }) => Promise<{
    id: string;
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number | null; output_tokens: number; cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null };
  }>;
};

export type ProductDiagnosticV2RunSuccess = {
  ok: true;
  result: ProductDiagnosticResultV2;
  messageId: string;
  model: string;
  promptVersion: string;
  usage: { inputTokens: number | null; outputTokens: number; cacheCreationInputTokens: number | null; cacheReadInputTokens: number | null };
  latencyMs: number;
};

/** retryable=true only for 429/5xx/timeout — a structural 400 (bad request/schema) or a model-output problem never succeeds on blind retry, so the job queue must not keep spending API calls on it. */
export type ProductDiagnosticV2RunFailure = { ok: false; errorCode: string; errorMessage: string; retryable: boolean; latencyMs: number };

/** Anthropic SDK errors carry a numeric `.status`; network/timeout failures often don't and are classified by message instead. */
function classifyAnthropicErrorRetryable(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  if (error instanceof Error && /timeout|timed out|ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(error.message)) return true;
  return false;
}

function truncate(text: string, maxChars: number) {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** Never trust the model to self-limit — hard caps regardless of what the JSON schema hints did or didn't enforce. */
function enforceLimits(result: ProductDiagnosticResultV2): ProductDiagnosticResultV2 {
  return {
    ...result,
    context: truncate(result.context, PRODUCT_DIAGNOSTIC_V2_LIMITS.contextMaxChars),
    primaryCause: result.primaryCause
      ? {
          ...result.primaryCause,
          title: truncate(result.primaryCause.title, PRODUCT_DIAGNOSTIC_V2_LIMITS.primaryCauseTitleMaxChars),
          explanation: truncate(result.primaryCause.explanation, PRODUCT_DIAGNOSTIC_V2_LIMITS.primaryCauseExplanationMaxChars),
        }
      : null,
    secondaryHypotheses: result.secondaryHypotheses.slice(0, PRODUCT_DIAGNOSTIC_V2_LIMITS.secondaryHypothesesMax),
    actions: result.actions.slice(0, PRODUCT_DIAGNOSTIC_V2_LIMITS.actionsMax).map((action) => ({ ...action, reason: truncate(action.reason, PRODUCT_DIAGNOSTIC_V2_LIMITS.actionReasonMaxChars) })),
    limitations: result.limitations.slice(0, PRODUCT_DIAGNOSTIC_V2_LIMITS.limitationsMax),
  };
}

function collectEvidenceRefs(result: ProductDiagnosticResultV2): string[] {
  const refs: string[] = [];
  if (result.primaryCause) refs.push(...result.primaryCause.evidenceRefs);
  for (const hypothesis of result.secondaryHypotheses) refs.push(...hypothesis.evidenceRefs);
  refs.push(...result.marketAssessment.evidenceRefs);
  for (const action of result.actions) refs.push(...action.evidenceRefs);
  return refs;
}

/** market.*.price_to_win and market.*.suggested_price evidence values are the only valid source for a monetary ADJUST_PRICE suggestion — Claude must never invent a number. */
function collectValidTargetPrices(evidence: Evidence[]): number[] {
  const prices: number[] = [];
  for (const item of evidence) {
    if (!(item.id.includes(".price_to_win") || item.id.includes(".suggested_price"))) continue;
    if (typeof item.value === "number") prices.push(item.value);
  }
  return prices;
}

function parseMonetaryValue(value: string): number | null {
  const match = value.match(/-?\d+([.,]\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeErrorMessage(message: string) {
  return message.slice(0, 500);
}

export async function runProductDiagnosticV2(params: {
  evidence: Evidence[];
  product: { sku: string; name: string };
  asOfDate: string;
  trigger: string;
  model: string;
  client: AnthropicMessagesAdapter | null | undefined;
}): Promise<ProductDiagnosticV2RunSuccess | ProductDiagnosticV2RunFailure> {
  const startedAt = Date.now();
  const adapter = params.client;
  if (!adapter) {
    return { ok: false, errorCode: "ANTHROPIC_NOT_CONFIGURED", errorMessage: "ANTHROPIC_API_KEY is not configured.", retryable: false, latencyMs: Date.now() - startedAt };
  }

  const evidenceIds = new Set(params.evidence.map((item) => item.id));
  const userMessage = buildProductDiagnosticUserMessageV2({ product: params.product, asOfDate: params.asOfDate, trigger: params.trigger, evidence: params.evidence });

  let response;
  try {
    response = await adapter.create({
      model: params.model,
      max_tokens: 2000,
      system: PRODUCT_DIAGNOSTIC_SYSTEM_PROMPT_V2,
      messages: [{ role: "user", content: userMessage }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: PREPARED_SCHEMA } },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return { ok: false, errorCode: "ANTHROPIC_REQUEST_FAILED", errorMessage: sanitizeErrorMessage(message), retryable: classifyAnthropicErrorRetryable(error), latencyMs: Date.now() - startedAt };
  }

  const latencyMs = Date.now() - startedAt;
  const textBlock = response.content.find((block) => block.type === "text") as { type: string; text?: string } | undefined;
  if (!textBlock?.text) {
    return { ok: false, errorCode: "EMPTY_RESPONSE", errorMessage: "Anthropic response had no text content.", retryable: false, latencyMs };
  }

  let parsed: ProductDiagnosticResultV2;
  try {
    parsed = enforceLimits(JSON.parse(textBlock.text) as ProductDiagnosticResultV2);
  } catch {
    return { ok: false, errorCode: "INVALID_JSON_RESPONSE", errorMessage: "Anthropic response was not valid JSON.", retryable: false, latencyMs };
  }

  const referencedIds = collectEvidenceRefs(parsed);
  const unknownRef = referencedIds.find((ref) => !evidenceIds.has(ref));
  if (unknownRef) {
    return { ok: false, errorCode: "INVALID_EVIDENCE_REFERENCE", errorMessage: sanitizeErrorMessage(`Referenced evidence id does not exist: ${unknownRef}`), retryable: false, latencyMs };
  }

  const validTargetPrices = collectValidTargetPrices(params.evidence);
  for (const action of parsed.actions) {
    if (action.actionCode !== "ADJUST_PRICE" || action.suggestedValue === null) continue;
    const parsedValue = parseMonetaryValue(action.suggestedValue);
    const matchesEvidence = parsedValue !== null && validTargetPrices.some((price) => Math.abs(price - parsedValue) < 0.01);
    if (!matchesEvidence) {
      return { ok: false, errorCode: "INVALID_PRICE_TARGET", errorMessage: sanitizeErrorMessage(`ADJUST_PRICE suggestedValue does not match any price_to_win/suggested_price evidence: ${action.suggestedValue}`), retryable: false, latencyMs };
    }
  }

  return {
    ok: true,
    result: parsed,
    messageId: response.id,
    model: params.model,
    promptVersion: PRODUCT_DIAGNOSTIC_PROMPT_VERSION_V2,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens,
      cacheReadInputTokens: response.usage.cache_read_input_tokens,
    },
    latencyMs,
  };
}
