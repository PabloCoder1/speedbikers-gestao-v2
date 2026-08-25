import { describe, expect, it, vi } from "vitest";

const createMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

const { createAnthropicClient, AnthropicClientError } = await import("./anthropic-client.js");

/**
 * Preço fixo em `anthropic-client.ts` (D-082): Haiku 4.5, $1/MTok entrada,
 * $5/MTok saída. Estes testes fixam esse cálculo — mudar o preço sem
 * atualizar aqui quebra o teste, é intencional (nunca um custo errado
 * passando silenciosamente).
 */
describe("createAnthropicClient", () => {
  it("calcula o custo em USD a partir do uso real de tokens devolvido pela API", async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "Queda de venda confirmada." }],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    const client = createAnthropicClient("chave-de-teste");
    const result = await client.narrate({ system: "system prompt", prompt: "narre isso" });

    // 500/1e6 * $1 + 100/1e6 * $5 = 0.0005 + 0.0005 = 0.001
    expect(result).toEqual({ text: "Queda de venda confirmada.", costUsd: 0.001 });
  });

  it("junta múltiplos blocos de texto e ignora blocos que não são texto", async () => {
    createMock.mockResolvedValueOnce({
      content: [
        { type: "tool_use", id: "x" },
        { type: "text", text: "Primeira frase." },
        { type: "text", text: "Segunda frase." },
      ],
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const client = createAnthropicClient("chave-de-teste");
    const result = await client.narrate({ system: "s", prompt: "p" });

    expect(result.text).toBe("Primeira frase.\nSegunda frase.");
  });

  it("lança AnthropicClientError quando a resposta não tem texto nenhum", async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "x" }],
      usage: { input_tokens: 10, output_tokens: 0 },
    });

    const client = createAnthropicClient("chave-de-teste");

    await expect(client.narrate({ system: "s", prompt: "p" })).rejects.toThrow(AnthropicClientError);
  });

  it("passa o modelo Haiku 4.5, o system prompt e a mensagem do usuário para o SDK", async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const client = createAnthropicClient("chave-de-teste");
    await client.narrate({ system: "regras estritas", prompt: "narre o diagnóstico" });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-4-5-20251001",
        system: "regras estritas",
        messages: [{ role: "user", content: "narre o diagnóstico" }],
      }),
    );
  });
});
