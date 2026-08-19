import "server-only";

import Anthropic from "@anthropic-ai/sdk";

let cachedClient: Anthropic | null | undefined;

/** Returns null (never throws) when ANTHROPIC_API_KEY is absent, so callers can surface an "anthropic_not_configured" state instead of a 500. */
export function getAnthropicClient(): Anthropic | null {
  if (cachedClient !== undefined) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  cachedClient = apiKey ? new Anthropic({ apiKey }) : null;
  return cachedClient;
}

/** Default fallback is Haiku 4.5 (fastest available) — Sonnet 5 was slow enough on the 3 Claude calls in the V2 pipeline (diagnostic, market research, vision) to contribute to worker timeouts in production. Override via ANTHROPIC_DIAGNOSTIC_MODEL if a stronger model is wanted for quality over latency. */
export function getProductDiagnosticModel() {
  return process.env.ANTHROPIC_DIAGNOSTIC_MODEL ?? "claude-haiku-4-5";
}

export function isAnthropicConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
