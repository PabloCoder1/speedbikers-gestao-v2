import Anthropic from "@anthropic-ai/sdk";

/**
 * Cliente fino sobre o SDK da Anthropic — Claude Haiku 4.5 (D-082,
 * `docs/COPILOT.md` secao 9/10). Único ponto do monorepo que fala com a
 * API da Anthropic; nenhuma outra parte do código deve importar o SDK
 * direto (mesmo raciocínio de `@sb/db` ser o único lugar que fala com o
 * Supabase).
 *
 * Preço fixo em código, não configurável: `docs/about-claude/pricing`
 * (Anthropic, conferido em 2026-08-25) — Haiku 4.5, $1/MTok de entrada,
 * $5/MTok de saída, sem cache/batch (esta chamada não usa nenhum dos
 * dois). Se o preço mudar, é um valor a atualizar aqui, não uma fórmula.
 */

const MODEL = "claude-haiku-4-5-20251001";
const MAX_OUTPUT_TOKENS = 512;

const INPUT_USD_PER_MTOK = 1;
const OUTPUT_USD_PER_MTOK = 5;

export interface NarrateResult {
  text: string;
  costUsd: number;
}

export interface AnthropicClient {
  /**
   * `maxTokens` opcional (default 512, o suficiente para narração): a
   * estruturação de sugestões (D-112) devolve 9 campos em JSON e 512
   * cortaria o objeto no meio — JSON truncado é falha certa de parse.
   */
  narrate: (input: { system: string; prompt: string; maxTokens?: number }) => Promise<NarrateResult>;
}

export class AnthropicClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicClientError";
  }
}

export function createAnthropicClient(apiKey: string): AnthropicClient {
  const client = new Anthropic({ apiKey });

  return {
    narrate: async ({ system, prompt, maxTokens }) => {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: maxTokens ?? MAX_OUTPUT_TOKENS,
        system,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      if (text.length === 0) {
        throw new AnthropicClientError("resposta vazia do modelo");
      }

      const costUsd =
        (response.usage.input_tokens / 1_000_000) * INPUT_USD_PER_MTOK +
        (response.usage.output_tokens / 1_000_000) * OUTPUT_USD_PER_MTOK;

      return { text, costUsd };
    },
  };
}
