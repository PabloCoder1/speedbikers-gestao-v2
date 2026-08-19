import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareAnthropicStructuredOutputSchema } from "./prepare-structured-output-schema";
import { PRODUCT_DIAGNOSTIC_V2_RESULT_JSON_SCHEMA } from "../../features/product-diagnostics/product-diagnostic-schema-v2";
import { MARKET_RESEARCH_JSON_SCHEMA } from "../../features/product-diagnostics/run-market-research";
import { VISION_ASSESSMENT_JSON_SCHEMA } from "../../features/product-diagnostics/product-diagnostic-vision";

const FORBIDDEN_KEYWORDS = ["maxItems", "minItems", "maxLength", "minLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "uniqueItems"];

function walk(node: unknown, visit: (key: string) => void) {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      visit(key);
      walk(value, visit);
    }
  }
}

function assertNoForbiddenKeywords(schema: unknown) {
  const found: string[] = [];
  walk(schema, (key) => {
    if (FORBIDDEN_KEYWORDS.includes(key)) found.push(key);
  });
  assert.deepEqual(found, []);
}

test("prepareAnthropicStructuredOutputSchema strips maxItems/minItems/maxLength/etc. at any depth", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: { type: "array", maxItems: 4, minItems: 1, items: { type: "string", maxLength: 100, minLength: 1 } },
      price: { type: "number", minimum: 0, maximum: 1000, exclusiveMinimum: 0, exclusiveMaximum: 1000, multipleOf: 0.01 },
      tags: { type: "array", uniqueItems: true, items: { type: "string" } },
    },
  };
  const prepared = prepareAnthropicStructuredOutputSchema(schema);
  assertNoForbiddenKeywords(prepared);
});

test("prepareAnthropicStructuredOutputSchema never removes type/properties/required/additionalProperties/enum/items", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: { status: { type: "string", enum: ["a", "b"], maxLength: 10 } },
  };
  const prepared = prepareAnthropicStructuredOutputSchema(schema) as typeof schema;
  assert.equal(prepared.type, "object");
  assert.equal(prepared.additionalProperties, false);
  assert.deepEqual(prepared.required, ["status"]);
  assert.deepEqual(prepared.properties.status.enum, ["a", "b"]);
  assert.equal("maxLength" in prepared.properties.status, false);
});

// 1/2. o schema enviado a Anthropic (diagnostic V2, market research, vision) nao contem maxItems/maxLength
test("the actual V2 diagnostic schema sent to Anthropic never contains maxItems/maxLength/etc. after preparation", () => {
  assertNoForbiddenKeywords(prepareAnthropicStructuredOutputSchema(PRODUCT_DIAGNOSTIC_V2_RESULT_JSON_SCHEMA));
});

test("the actual market research schema sent to Anthropic never contains maxItems/maxLength/etc. after preparation", () => {
  assertNoForbiddenKeywords(prepareAnthropicStructuredOutputSchema(MARKET_RESEARCH_JSON_SCHEMA));
});

test("the actual vision assessment schema sent to Anthropic never contains maxItems/maxLength/etc. after preparation", () => {
  assertNoForbiddenKeywords(prepareAnthropicStructuredOutputSchema(VISION_ASSESSMENT_JSON_SCHEMA));
});

// sanity: the raw (un-prepared) source schemas DO still declare these limits as app-level rules
test("the raw source schemas still declare the limits as application rules (not deleted, only stripped before sending)", () => {
  const raw = JSON.stringify(PRODUCT_DIAGNOSTIC_V2_RESULT_JSON_SCHEMA);
  assert.match(raw, /maxItems|maxLength/);
});
