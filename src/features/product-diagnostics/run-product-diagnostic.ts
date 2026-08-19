/*
 * Deliberately free of `import "server-only"` and of any import that
 * transitively pulls it in (like @/integrations/anthropic/client) — the
 * `server-only` package is not resolvable under plain `node:test`, so this
 * file takes its Anthropic client as an explicit parameter instead. The
 * caller (the API route) resolves the real client from the server-only
 * module and passes it in; unit tests pass a mock adapter. Same pattern as
 * the project's other "pure/testable sibling" files.
 */
import type { Evidence } from "@/features/product-diagnostics/product-diagnostic-domain";
import {
  PRODUCT_DIAGNOSTIC_PROMPT_VERSION,
  PRODUCT_DIAGNOSTIC_SYSTEM_PROMPT,
  buildProductDiagnosticUserMessage,
} from "@/features/product-diagnostics/product-diagnostic-prompt";
import { PRODUCT_DIAGNOSTIC_RESULT_JSON_SCHEMA, type ProductDiagnosticResult } from "@/features/product-diagnostics/product-diagnostic-schema";

/** Minimal shape of the Anthropic messages resource — narrow enough that unit tests can pass a mock without touching the real API. */
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
    usage: {
      input_tokens: number | null;
      output_tokens: number;
      cache_creation_input_tokens: number | null;
      cache_read_input_tokens: number | null;
    };
  }>;
};

export type ProductDiagnosticRunSuccess = {
  ok: true;
  result: ProductDiagnosticResult;
  messageId: string;
  model: string;
  promptVersion: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number;
    cacheCreationInputTokens: number | null;
    cacheReadInputTokens: number | null;
  };
  latencyMs: number;
};

export type ProductDiagnosticRunFailure = {
  ok: false;
  errorCode: string;
  errorMessage: string;
  latencyMs: number;
};

function collectEvidenceRefs(result: ProductDiagnosticResult): string[] {
  const refs: string[] = [];
  for (const correlation of result.correlations) refs.push(...correlation.evidenceRefs);
  for (const hypothesis of result.hypotheses) {
    refs.push(...hypothesis.evidenceRefs);
    refs.push(...hypothesis.counterEvidenceRefs);
  }
  for (const action of result.recommendedActions) refs.push(...action.evidenceRefs);
  return refs;
}

function sanitizeErrorMessage(message: string) {
  return message.slice(0, 500);
}

export async function runProductDiagnostic(params: {
  evidence: Evidence[];
  product: { sku: string; name: string };
  asOfDate: string;
  trigger: string;
  model: string;
  /** null/undefined means Anthropic is not configured — the caller resolves this from the server-only client module. */
  client: AnthropicMessagesAdapter | null | undefined;
}): Promise<ProductDiagnosticRunSuccess | ProductDiagnosticRunFailure> {
  const startedAt = Date.now();
  const adapter = params.client;
  if (!adapter) {
    return { ok: false, errorCode: "ANTHROPIC_NOT_CONFIGURED", errorMessage: "ANTHROPIC_API_KEY is not configured.", latencyMs: Date.now() - startedAt };
  }

  const evidenceIds = new Set(params.evidence.map((item) => item.id));
  const userMessage = buildProductDiagnosticUserMessage({
    product: params.product,
    asOfDate: params.asOfDate,
    trigger: params.trigger,
    evidence: params.evidence,
  });

  let response;
  try {
    response = await adapter.create({
      model: params.model,
      max_tokens: 4096,
      system: PRODUCT_DIAGNOSTIC_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: PRODUCT_DIAGNOSTIC_RESULT_JSON_SCHEMA },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return { ok: false, errorCode: "ANTHROPIC_REQUEST_FAILED", errorMessage: sanitizeErrorMessage(message), latencyMs: Date.now() - startedAt };
  }

  const latencyMs = Date.now() - startedAt;
  const textBlock = response.content.find((block) => block.type === "text") as { type: string; text?: string } | undefined;
  if (!textBlock?.text) {
    return { ok: false, errorCode: "EMPTY_RESPONSE", errorMessage: "Anthropic response had no text content.", latencyMs };
  }

  let parsed: ProductDiagnosticResult;
  try {
    parsed = JSON.parse(textBlock.text) as ProductDiagnosticResult;
  } catch {
    return { ok: false, errorCode: "INVALID_JSON_RESPONSE", errorMessage: "Anthropic response was not valid JSON.", latencyMs };
  }

  const referencedIds = collectEvidenceRefs(parsed);
  const unknownRef = referencedIds.find((ref) => !evidenceIds.has(ref));
  if (unknownRef) {
    return {
      ok: false,
      errorCode: "INVALID_EVIDENCE_REFERENCE",
      errorMessage: sanitizeErrorMessage(`Referenced evidence id does not exist: ${unknownRef}`),
      latencyMs,
    };
  }

  return {
    ok: true,
    result: parsed,
    messageId: response.id,
    model: params.model,
    promptVersion: PRODUCT_DIAGNOSTIC_PROMPT_VERSION,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens,
      cacheReadInputTokens: response.usage.cache_read_input_tokens,
    },
    latencyMs,
  };
}
