import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";

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

/** Definição de ferramenta no formato da API de tool use. */
export interface PlanToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Mensagem do histórico do planner — `content` no formato da API (texto ou blocos). */
export interface PlanMessage {
  role: "user" | "assistant";
  content: unknown;
}

export type PlanBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface PlanResult {
  blocks: PlanBlock[];
  stopReason: "tool_use" | "end_turn";
  costUsd: number;
}

export interface AnthropicClient {
  /**
   * `maxTokens` opcional (default 512, o suficiente para narração): a
   * estruturação de sugestões (D-112) devolve 9 campos em JSON e 512
   * cortaria o objeto no meio — JSON truncado é falha certa de parse.
   */
  narrate: (input: { system: string; prompt: string; maxTokens?: number }) => Promise<NarrateResult>;
  /**
   * Uma rodada do planner (D-114), com STREAMING de verdade: cada delta de
   * texto é entregue a `onText` no instante em que chega — é o que a rota
   * SSE repassa ao navegador. Blocos `tool_use` são coletados e devolvidos
   * no fim da rodada; o loop de orquestração vive em `copilot-chat.ts`,
   * nunca aqui (este arquivo só traduz o SDK).
   */
  plan: (input: {
    system: string;
    messages: PlanMessage[];
    tools: PlanToolDefinition[];
    maxTokens: number;
    onText: (delta: string) => void;
  }) => Promise<PlanResult>;
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

    plan: async ({ system, messages, tools, maxTokens, onText }) => {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        // O SDK aceita os formatos que PlanMessage/PlanToolDefinition
        // espelham; os casts localizam a fronteira num lugar só — este
        // arquivo é o único autorizado a conhecer os tipos do SDK.
        messages: messages as MessageParam[],
        tools: tools as Tool[],
      });

      stream.on("text", (delta) => {
        onText(delta);
      });

      const final = await stream.finalMessage();

      const blocks: PlanBlock[] = final.content.flatMap((block): PlanBlock[] => {
        if (block.type === "text") {
          return [{ type: "text", text: block.text }];
        }

        if (block.type === "tool_use") {
          return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
        }

        return [];
      });

      const costUsd =
        (final.usage.input_tokens / 1_000_000) * INPUT_USD_PER_MTOK +
        (final.usage.output_tokens / 1_000_000) * OUTPUT_USD_PER_MTOK;

      return {
        blocks,
        stopReason: final.stop_reason === "tool_use" ? "tool_use" : "end_turn",
        costUsd,
      };
    },
  };
}
