/*
 * Free of `import "server-only"` for the same reason as
 * run-product-diagnostic.ts — the Anthropic client is injected by the
 * caller (server-only), so this file stays importable by node:test.
 */
import {
  VISION_ASSESSMENT_JSON_SCHEMA,
  VISION_ASSESSMENT_SYSTEM_PROMPT,
  buildVisionAssessmentUserMessage,
  type CompetitorReferenceImage,
  type OurListingImage,
  type VisionAssessmentResult,
} from "@/features/product-diagnostics/product-diagnostic-vision";

export type AnthropicVisionAdapter = {
  create: (params: {
    model: string;
    max_tokens: number;
    system: string;
    messages: Array<{ role: "user"; content: Array<{ type: "image"; source: { type: "url"; url: string } } | { type: "text"; text: string }> }>;
    output_config: { effort: "low"; format: { type: "json_schema"; schema: Record<string, unknown> } };
  }) => Promise<{
    id: string;
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number | null; output_tokens: number; cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null };
  }>;
};

export type VisionAssessmentSuccess = {
  ok: true;
  result: VisionAssessmentResult;
  messageId: string;
  usage: { inputTokens: number | null; outputTokens: number };
  latencyMs: number;
};

export type VisionAssessmentFailure = { ok: false; errorCode: string; errorMessage: string; latencyMs: number };

function sanitize(message: string) {
  return message.slice(0, 500);
}

const MAX_OUR_IMAGES = 4;
const MAX_REFERENCE_IMAGES = 3;

export async function runVisionAssessment(params: {
  ourImages: OurListingImage[];
  referenceImages: CompetitorReferenceImage[];
  model: string;
  client: AnthropicVisionAdapter | null | undefined;
}): Promise<VisionAssessmentSuccess | VisionAssessmentFailure> {
  const startedAt = Date.now();
  if (!params.client) {
    return { ok: false, errorCode: "ANTHROPIC_NOT_CONFIGURED", errorMessage: "ANTHROPIC_API_KEY is not configured.", latencyMs: Date.now() - startedAt };
  }

  const ourImages = params.ourImages.slice(0, MAX_OUR_IMAGES);
  const referenceImages = params.referenceImages.slice(0, MAX_REFERENCE_IMAGES);
  if (ourImages.length === 0) {
    return { ok: false, errorCode: "NO_IMAGES", errorMessage: "No listing images available to assess.", latencyMs: Date.now() - startedAt };
  }

  const content: Array<{ type: "image"; source: { type: "url"; url: string } } | { type: "text"; text: string }> = [
    { type: "text", text: buildVisionAssessmentUserMessage(ourImages, referenceImages) },
    ...ourImages.map((image) => ({ type: "image" as const, source: { type: "url" as const, url: image.imageUrl } })),
    ...referenceImages.map((image) => ({ type: "image" as const, source: { type: "url" as const, url: image.imageUrl } })),
  ];

  let response;
  try {
    response = await params.client.create({
      model: params.model,
      max_tokens: 800,
      system: VISION_ASSESSMENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
      output_config: { effort: "low", format: { type: "json_schema", schema: VISION_ASSESSMENT_JSON_SCHEMA } },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return { ok: false, errorCode: "ANTHROPIC_REQUEST_FAILED", errorMessage: sanitize(message), latencyMs: Date.now() - startedAt };
  }

  const latencyMs = Date.now() - startedAt;
  const textBlock = response.content.find((block) => block.type === "text") as { type: string; text?: string } | undefined;
  if (!textBlock?.text) {
    return { ok: false, errorCode: "EMPTY_RESPONSE", errorMessage: "Anthropic response had no text content.", latencyMs };
  }

  let parsed: VisionAssessmentResult;
  try {
    parsed = JSON.parse(textBlock.text) as VisionAssessmentResult;
  } catch {
    return { ok: false, errorCode: "INVALID_JSON_RESPONSE", errorMessage: "Anthropic response was not valid JSON.", latencyMs };
  }

  return {
    ok: true,
    result: parsed,
    messageId: response.id,
    usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    latencyMs,
  };
}
