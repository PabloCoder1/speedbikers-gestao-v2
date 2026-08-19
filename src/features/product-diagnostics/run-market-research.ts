/*
 * Free of `import "server-only"` — same reasoning as
 * run-product-diagnostic.ts: the Anthropic client is injected by the
 * caller, so this stays importable by node:test.
 */
import type { ExternalMarketResult } from "@/features/product-diagnostics/product-market-evidence-domain";
import { prepareAnthropicStructuredOutputSchema } from "@/integrations/anthropic/prepare-structured-output-schema";

/** App-level rules the schema hint can no longer enforce (Anthropic rejects maxItems/maxLength) — applied server-side after parsing instead. */
const MARKET_RESEARCH_LIMITS = { resultsMax: 8, summaryMaxChars: 300 } as const;

export const MARKET_RESEARCH_PROMPT_VERSION = "product-market-research-v1";

export const MARKET_RESEARCH_SYSTEM_PROMPT = `Voce esta pesquisando o mercado brasileiro (prioritariamente Mercado Livre e e-commerce brasileiro relevante) para encontrar ofertas do MESMO produto especifico informado, usando a ferramenta de busca web.

Regras:
1. Use os identificadores fortes fornecidos (marca, part number, EAN, nome, compatibilidade) — nunca busque apenas por um titulo generico se identificadores melhores existem.
2. Classifique cada resultado como "exact" (mesmo produto, mesma marca, mesmo modelo/compatibilidade, condicao equivalente), "probable" (muito provavelmente o mesmo produto mas com alguma incerteza) ou "weak" (relacionado mas nao claramente o mesmo produto).
3. Nunca compare produtos diferentes como se fossem o mesmo: kit vs unitario, novo vs usado, marca diferente sem equivalencia comprovada, quantidade diferente, modelo diferente, compatibilidade diferente contam como produto diferente.
4. So inclua o preco observado quando ele estiver claramente visivel no resultado.
5. Faca no maximo 3 buscas.
6. summary deve ser curto (uma frase) e so pode afirmar uma faixa de preco se os resultados exact/probable realmente sustentarem isso. Se nada relevante foi encontrado, diga isso claramente.

Responda estritamente no formato estruturado fornecido apos concluir as buscas.`;

export type MarketResearchResult = {
  results: Array<{
    title: string;
    url: string;
    domain: string;
    priceObserved: number | null;
    currencyObserved: string | null;
    matchConfidence: "exact" | "probable" | "weak";
  }>;
  summary: string;
};

export const MARKET_RESEARCH_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results", "summary"],
  properties: {
    results: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url", "domain", "priceObserved", "currencyObserved", "matchConfidence"],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          domain: { type: "string" },
          priceObserved: { type: ["number", "null"] },
          currencyObserved: { type: ["string", "null"] },
          matchConfidence: { type: "string", enum: ["exact", "probable", "weak"] },
        },
      },
    },
    summary: { type: "string", maxLength: 300 },
  },
} as const;

export type AnthropicMarketResearchAdapter = {
  create: (params: {
    model: string;
    max_tokens: number;
    system: string;
    messages: Array<{ role: "user"; content: string }>;
    tools: Array<{ type: "web_search_20260318"; name: "web_search"; max_uses: number }>;
    output_config: { effort: "low"; format: { type: "json_schema"; schema: Record<string, unknown> } };
  }) => Promise<{
    id: string;
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number | null; output_tokens: number; server_tool_use?: { web_search_requests: number } | null };
  }>;
};

export type MarketResearchSuccess = {
  ok: true;
  externalResults: ExternalMarketResult[];
  summary: string;
  messageId: string;
  usage: { inputTokens: number | null; outputTokens: number; webSearchRequests: number };
  latencyMs: number;
};

/** retryable=true only for 429/5xx/timeout, matching run-product-diagnostic-v2.ts's classification. */
export type MarketResearchFailure = { ok: false; errorCode: string; errorMessage: string; retryable: boolean; latencyMs: number };

const MAX_WEB_SEARCHES = 3;
const PREPARED_SCHEMA = prepareAnthropicStructuredOutputSchema(MARKET_RESEARCH_JSON_SCHEMA);

function sanitize(message: string) {
  return message.slice(0, 500);
}

function classifyAnthropicErrorRetryable(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  if (error instanceof Error && /timeout|timed out|ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(error.message)) return true;
  return false;
}

export async function runMarketResearch(params: {
  query: string;
  model: string;
  client: AnthropicMarketResearchAdapter | null | undefined;
}): Promise<MarketResearchSuccess | MarketResearchFailure> {
  const startedAt = Date.now();
  if (!params.client) {
    return { ok: false, errorCode: "ANTHROPIC_NOT_CONFIGURED", errorMessage: "ANTHROPIC_API_KEY is not configured.", retryable: false, latencyMs: Date.now() - startedAt };
  }

  let response;
  try {
    response = await params.client.create({
      model: params.model,
      max_tokens: 1200,
      system: MARKET_RESEARCH_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Pesquise ofertas para: ${params.query}` }],
      tools: [{ type: "web_search_20260318", name: "web_search", max_uses: MAX_WEB_SEARCHES }],
      output_config: { effort: "low", format: { type: "json_schema", schema: PREPARED_SCHEMA } },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return { ok: false, errorCode: "ANTHROPIC_REQUEST_FAILED", errorMessage: sanitize(message), retryable: classifyAnthropicErrorRetryable(error), latencyMs: Date.now() - startedAt };
  }

  const latencyMs = Date.now() - startedAt;
  const textBlock = response.content.find((block) => block.type === "text") as { type: string; text?: string } | undefined;
  if (!textBlock?.text) {
    return { ok: false, errorCode: "EMPTY_RESPONSE", errorMessage: "Anthropic response had no text content.", retryable: false, latencyMs };
  }

  let parsed: MarketResearchResult;
  try {
    parsed = JSON.parse(textBlock.text) as MarketResearchResult;
  } catch {
    return { ok: false, errorCode: "INVALID_JSON_RESPONSE", errorMessage: "Anthropic response was not valid JSON.", retryable: false, latencyMs };
  }

  // Schema can no longer enforce these (Structured Output rejects maxItems/maxLength) — cut the benign excess deterministically rather than reject a structurally valid response.
  const boundedResults = parsed.results.slice(0, MARKET_RESEARCH_LIMITS.resultsMax);
  const boundedSummary = parsed.summary.length > MARKET_RESEARCH_LIMITS.summaryMaxChars ? parsed.summary.slice(0, MARKET_RESEARCH_LIMITS.summaryMaxChars) : parsed.summary;

  const fetchedAt = new Date().toISOString();
  const externalResults: ExternalMarketResult[] = boundedResults.map((result) => ({
    title: result.title,
    url: result.url,
    domain: result.domain,
    priceObserved: result.priceObserved,
    currencyObserved: result.currencyObserved,
    matchConfidence: result.matchConfidence,
    fetchedAt,
  }));

  return {
    ok: true,
    externalResults,
    summary: boundedSummary,
    messageId: response.id,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      webSearchRequests: response.usage.server_tool_use?.web_search_requests ?? 0,
    },
    latencyMs,
  };
}
