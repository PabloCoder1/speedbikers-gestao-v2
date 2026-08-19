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

export function getProductDiagnosticModel() {
  return process.env.ANTHROPIC_DIAGNOSTIC_MODEL ?? "claude-sonnet-5";
}

export function isAnthropicConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
