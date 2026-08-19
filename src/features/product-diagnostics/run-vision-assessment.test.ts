import assert from "node:assert/strict";
import { test } from "node:test";

import type { AnthropicVisionAdapter } from "./run-vision-assessment";
import { runVisionAssessment } from "./run-vision-assessment";

function mockAdapter(handler: AnthropicVisionAdapter["create"]): AnthropicVisionAdapter {
  return { create: handler };
}

// 20. vision recebe no máximo o número de imagens permitido (4 nossas, 3 de referência)
test("vision assessment sends at most 4 of our images and 3 competitor references", async () => {
  let capturedImageCount = 0;
  const client = mockAdapter(async (params) => {
    capturedImageCount = params.messages[0].content.filter((block) => block.type === "image").length;
    return {
      id: "msg_v1",
      content: [{ type: "text", text: JSON.stringify({ images: [] }) }],
      usage: { input_tokens: 500, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  });

  const ourImages = Array.from({ length: 6 }, (_, i) => ({ accountCode: `acc${i}`, itemId: `MLB${i}`, imageUrl: `https://example.com/${i}.jpg` }));
  const referenceImages = Array.from({ length: 5 }, (_, i) => ({ title: `ref${i}`, imageUrl: `https://example.com/ref${i}.jpg` }));

  const outcome = await runVisionAssessment({ ourImages, referenceImages, model: "claude-sonnet-5", client });
  assert.equal(outcome.ok, true);
  assert.equal(capturedImageCount, 4 + 3);
});

test("no listing images available resolves gracefully instead of calling Anthropic", async () => {
  const client = mockAdapter(async () => {
    throw new Error("should not be called");
  });
  const outcome = await runVisionAssessment({ ourImages: [], referenceImages: [], model: "claude-sonnet-5", client });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.errorCode, "NO_IMAGES");
});

test("a missing Anthropic client resolves gracefully instead of throwing", async () => {
  const outcome = await runVisionAssessment({
    ourImages: [{ accountCode: "gmr", itemId: "MLB1", imageUrl: "https://example.com/1.jpg" }],
    referenceImages: [],
    model: "claude-sonnet-5",
    client: null,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.errorCode, "ANTHROPIC_NOT_CONFIGURED");
});

test("a valid vision response is parsed successfully", async () => {
  const client = mockAdapter(async () => ({
    id: "msg_v2",
    content: [{ type: "text", text: JSON.stringify({ images: [{ accountCode: "gmr", itemId: "MLB1", clarity: "poor", framing: "poor", background: "busy", weakerThanReferences: true, notes: "Embalagem domina a foto." }] }) }],
    usage: { input_tokens: 600, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }));
  const outcome = await runVisionAssessment({
    ourImages: [{ accountCode: "gmr", itemId: "MLB1", imageUrl: "https://example.com/1.jpg" }],
    referenceImages: [],
    model: "claude-sonnet-5",
    client,
  });
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.result.images[0].weakerThanReferences, true);
});
