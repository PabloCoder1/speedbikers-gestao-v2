/*
 * Anthropic's Structured Output (output_config.format = json_schema) does
 * not support the full JSON Schema vocabulary — production evidence:
 * `output_config.format.schema: For 'array' type, property 'maxItems' is
 * not supported` (HTTP 400, ~250-450ms, before any generation happens).
 *
 * The SDK ships an official transform (jsonSchemaOutputFormat's
 * `transform` option, @anthropic-ai/sdk/helpers/json-schema.js ->
 * lib/transform-json-schema.js) but it does more than strip unsupported
 * count/length keywords: it also silently demotes `enum` (on any type) to
 * a JSON-stringified hint appended to `description`, because the function
 * never explicitly handles the `enum` keyword and its catch-all folds any
 * leftover key into descriptive text. Every schema in this codebase
 * (verdict, confidence, priority, actionCode, category, status...) relies
 * on `enum` being a REAL, enforced constraint, not a hint the model can
 * ignore — so the official transform is not a safe fit here. This is a
 * narrower, purpose-built alternative: it removes only the keywords
 * Anthropic's docs/production behavior have shown to be unsupported, and
 * leaves `type`, `properties`, `required`, `additionalProperties`, `enum`,
 * `items`, and `description` completely untouched.
 *
 * The removed constraints remain real, enforced rules of this application
 * — see PRODUCT_DIAGNOSTIC_V2_LIMITS and the server-side `enforceLimits`/
 * truncation logic in run-product-diagnostic-v2.ts and
 * run-market-research.ts. Claude is never the authority on these limits.
 */
const UNSUPPORTED_JSON_SCHEMA_KEYWORDS = new Set([
  "maxItems",
  "minItems",
  "maxLength",
  "minLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "uniqueItems",
]);

function stripUnsupportedKeywords(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupportedKeywords);
  if (node !== null && typeof node === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED_JSON_SCHEMA_KEYWORDS.has(key)) continue;
      result[key] = stripUnsupportedKeywords(value);
    }
    return result;
  }
  return node;
}

/** Recursively strips JSON Schema keywords Anthropic's Structured Output rejects, at any nesting depth. Never touches type/properties/required/additionalProperties/enum/items. */
export function prepareAnthropicStructuredOutputSchema<T extends Record<string, unknown>>(schema: T): T {
  return stripUnsupportedKeywords(schema) as T;
}
