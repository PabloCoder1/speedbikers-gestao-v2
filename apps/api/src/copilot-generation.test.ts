import type { UserClient } from "@sb/db";
import { describe, expect, it, vi } from "vitest";

import type { AnthropicClient } from "./anthropic-client.js";
import { runStructureFeatureSuggestion, runSuggestSupportReply } from "./copilot-generation.js";

/**
 * Fakes por tabela: cada `from(table)` devolve a cadeia mínima que a
 * ferramenta usa. Mesmo espírito dos fakes de `copilot.test.ts`.
 */

const CASE_ID = "11111111-0000-4000-8000-00000000c001";
const SUGGESTION_ID = "11111111-0000-4000-8000-00000000f001";

interface SupportFakes {
  supportCase: unknown;
  messages: unknown[];
  messagesError?: { message: string } | null;
  knowledge?: { kind: string; content: string }[];
}

function fakeSupportClient(fakes: SupportFakes): UserClient {
  return {
    from: (table: string) => {
      if (table === "support_cases") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: fakes.supportCase, error: null }),
        };

        return chain;
      }

      if (table === "support_messages") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => Promise.resolve({ data: fakes.messages, error: fakes.messagesError ?? null }),
        };

        return chain;
      }

      if (table === "knowledge_entries") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          or: () => chain,
          order: () => chain,
          limit: () => Promise.resolve({ data: fakes.knowledge ?? [], error: null }),
        };

        return chain;
      }

      throw new Error(`tabela inesperada: ${table}`);
    },
  } as unknown as UserClient;
}

function narrateReturning(text: string) {
  const narrate = vi.fn<AnthropicClient["narrate"]>(() => Promise.resolve({ text, costUsd: 0.001 }));

  return { anthropic: { narrate, plan: vi.fn<AnthropicClient["plan"]>() }, narrate };
}

const OPEN_CASE = {
  id: CASE_ID,
  channel: "QUESTION",
  external_type: null,
  external_status: "UNANSWERED",
  is_mediation: false,
  support_case_links: [{ sku_id: "sku-1", skus: { sku: "5821", title: "Baú 45L" }, listings: null }],
};

describe("runSuggestSupportReply", () => {
  it("case fora do alcance: erro antes de gastar LLM", async () => {
    const userClient = fakeSupportClient({ supportCase: null, messages: [] });
    const { anthropic, narrate } = narrateReturning("nunca");

    await expect(
      runSuggestSupportReply(userClient, { supportCaseId: CASE_ID }, anthropic),
    ).rejects.toThrow(/não encontrado ou sem permissão/i);
    expect(narrate).not.toHaveBeenCalled();
  });

  it("o prompt carrega transcript, produto e canal — e SÓ o que veio do banco", async () => {
    const userClient = fakeSupportClient({
      supportCase: OPEN_CASE,
      messages: [
        {
          direction: "INBOUND",
          sender_kind: "CUSTOMER",
          body: "Serve na X-ADV 2023?",
          body_state: "AVAILABLE",
          occurred_at: "2026-08-28T10:00:00Z",
        },
      ],
    });
    const { anthropic, narrate } = narrateReturning("Vamos confirmar a compatibilidade e te retornamos.");

    const outcome = await runSuggestSupportReply(userClient, { supportCaseId: CASE_ID }, anthropic);

    expect(outcome.data.suggestedText).toBe("Vamos confirmar a compatibilidade e te retornamos.");
    expect(outcome.costUsd).toBe(0.001);

    const prompt = narrate.mock.calls[0]?.[0]?.prompt ?? "";

    expect(prompt).toContain("pergunta pré-venda");
    expect(prompt).toContain("SKU 5821 — Baú 45L");
    expect(prompt).toContain("Cliente: Serve na X-ADV 2023?");
  });

  it("mensagem moderada vira rótulo, nunca o corpo — e nunca some", async () => {
    const userClient = fakeSupportClient({
      supportCase: OPEN_CASE,
      messages: [
        { direction: "INBOUND", sender_kind: "CUSTOMER", body: null, body_state: "BANNED", occurred_at: "2026-08-28T10:00:00Z" },
      ],
    });
    const { anthropic, narrate } = narrateReturning("ok");

    await runSuggestSupportReply(userClient, { supportCaseId: CASE_ID }, anthropic);

    expect(narrate.mock.calls[0]?.[0]?.prompt).toContain("[mensagem banned]");
  });

  it("conhecimento VALIDADO entra no prompt como evidência (D-113)", async () => {
    const userClient = fakeSupportClient({
      supportCase: {
        ...OPEN_CASE,
        support_case_links: [{ sku_id: "sku-1", skus: { sku: "5821", title: "Baú 45L" }, listings: null }],
      },
      messages: [],
      knowledge: [{ kind: "COMPATIBILIDADE", content: "Compatível com Honda X-ADV 750 2022-2025" }],
    });
    const { anthropic, narrate } = narrateReturning("ok");

    await runSuggestSupportReply(userClient, { supportCaseId: CASE_ID }, anthropic);

    const prompt = narrate.mock.calls[0]?.[0]?.prompt ?? "";

    expect(prompt).toContain("[COMPATIBILIDADE] Compatível com Honda X-ADV 750 2022-2025");
  });

  it("sem conhecimento validado, o prompt diz isso — nunca inventa evidência", async () => {
    const userClient = fakeSupportClient({ supportCase: OPEN_CASE, messages: [], knowledge: [] });
    const { anthropic, narrate } = narrateReturning("ok");

    await runSuggestSupportReply(userClient, { supportCaseId: CASE_ID }, anthropic);

    expect(narrate.mock.calls[0]?.[0]?.prompt).toContain("(nenhum registro para este produto)");
  });

  it("o system prompt proíbe inventar e proíbe placeholder", async () => {
    const userClient = fakeSupportClient({ supportCase: OPEN_CASE, messages: [] });
    const { anthropic, narrate } = narrateReturning("ok");

    await runSuggestSupportReply(userClient, { supportCaseId: CASE_ID }, anthropic);

    const system = narrate.mock.calls[0]?.[0]?.system ?? "";

    expect(system).toMatch(/Nunca invente/i);
    expect(system).toContain("{nome}");
  });
});

interface SuggestionFakes {
  suggestion: { id: string; original_text: string } | null;
  updateResult?: { data: unknown; error: { message: string } | null };
}

function fakeSuggestionClient(fakes: SuggestionFakes): { userClient: UserClient; updates: unknown[] } {
  const updates: unknown[] = [];

  const userClient = {
    from: (table: string) => {
      if (table !== "feature_suggestions") {
        throw new Error(`tabela inesperada: ${table}`);
      }

      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve(
            updates.length === 0
              ? { data: fakes.suggestion, error: null }
              : (fakes.updateResult ?? { data: { id: SUGGESTION_ID }, error: null }),
          ),
        update: (payload: unknown) => {
          updates.push(payload);

          return chain;
        },
      };

      return chain;
    },
  } as unknown as UserClient;

  return { userClient, updates };
}

const VALID_JSON = JSON.stringify({
  title: "Filtro por marca no estoque",
  problem: "Não dá para filtrar por marca",
  objective: "Filtrar rápido",
  impactedUsers: "Equipe de compras",
  suggestedFlow: null,
  expectedBenefit: "Menos tempo procurando",
  acceptanceCriteria: null,
  dependenciesRisks: null,
  complexity: "baixa — só um filtro a mais",
});

describe("runStructureFeatureSuggestion", () => {
  it("estrutura, persiste os nove campos e preserva original_text (não o toca)", async () => {
    const { userClient, updates } = fakeSuggestionClient({
      suggestion: { id: SUGGESTION_ID, original_text: "seria bom filtrar por marca" },
    });
    const { anthropic } = narrateReturning(VALID_JSON);

    const outcome = await runStructureFeatureSuggestion(userClient, { suggestionId: SUGGESTION_ID }, anthropic);

    expect(outcome.data.title).toBe("Filtro por marca no estoque");
    expect(updates).toHaveLength(1);

    const payload = updates[0] as Record<string, unknown>;

    expect(payload.title).toBe("Filtro por marca no estoque");
    expect(payload.impacted_users).toBe("Equipe de compras");
    // A garantia do requisito: o texto original NUNCA entra no UPDATE.
    expect("original_text" in payload).toBe(false);
  });

  it("aceita JSON cercado de markdown — o modelo às vezes cerca com ```", async () => {
    const { userClient } = fakeSuggestionClient({
      suggestion: { id: SUGGESTION_ID, original_text: "ideia" },
    });
    const { anthropic } = narrateReturning("```json\n" + VALID_JSON + "\n```");

    const outcome = await runStructureFeatureSuggestion(userClient, { suggestionId: SUGGESTION_ID }, anthropic);

    expect(outcome.data.problem).toBe("Não dá para filtrar por marca");
  });

  it("resposta fora do formato vira erro amigável, nunca campos meio gravados", async () => {
    const { userClient, updates } = fakeSuggestionClient({
      suggestion: { id: SUGGESTION_ID, original_text: "ideia" },
    });
    const { anthropic } = narrateReturning("desculpe, não consegui");

    await expect(
      runStructureFeatureSuggestion(userClient, { suggestionId: SUGGESTION_ID }, anthropic),
    ).rejects.toThrow(/formato esperado/i);
    expect(updates).toHaveLength(0);
  });

  it("RLS filtrando o UPDATE (papel sem alcance) vira erro claro, não sucesso", async () => {
    const { userClient } = fakeSuggestionClient({
      suggestion: { id: SUGGESTION_ID, original_text: "ideia" },
      updateResult: { data: null, error: null },
    });
    const { anthropic } = narrateReturning(VALID_JSON);

    await expect(
      runStructureFeatureSuggestion(userClient, { suggestionId: SUGGESTION_ID }, anthropic),
    ).rejects.toThrow(/ADMIN e GESTOR/i);
  });

  it("pede maxTokens maior — 512 truncaria o JSON no meio", async () => {
    const { userClient } = fakeSuggestionClient({
      suggestion: { id: SUGGESTION_ID, original_text: "ideia" },
    });
    const { anthropic, narrate } = narrateReturning(VALID_JSON);

    await runStructureFeatureSuggestion(userClient, { suggestionId: SUGGESTION_ID }, anthropic);

    expect(narrate.mock.calls[0]?.[0]?.maxTokens).toBe(1_024);
  });
});
