import type { UserClient } from "@sb/db";
import { describe, expect, it, vi } from "vitest";

import type { AnthropicClient, PlanResult } from "./anthropic-client.js";
import type { Caller } from "./auth.js";
import type { CopilotChatEvent } from "./copilot-chat.js";
import { runCopilotChat } from "./copilot-chat.js";
import type { CopilotDeps } from "./copilot.js";

const CALLER: Caller = {
  userId: "aaaaaaaa-0000-4000-8000-000000000001",
  organizationId: "11111111-0000-4000-8000-000000000001",
  role: "ADMIN",
};

const ACCOUNTS = [{ id: "acc-1", label: "Speedbikers loja 1" }];

const SUMMARY_ROW = {
  units_sold: 10,
  gross_revenue: 1000,
  orders_count: 5,
  purchases_count: 5,
  average_ticket: 200,
  average_selling_price: 100,
  last_computed_at: "2026-08-28T00:00:00Z",
};

/** Fake: `ml_accounts` para o system prompt e a RPC de vendas. */
function fakeUserClient(): UserClient {
  return {
    from: (table: string) => {
      if (table !== "ml_accounts") throw new Error(`tabela inesperada: ${table}`);

      const chain = {
        select: () => chain,
        order: () => Promise.resolve({ data: ACCOUNTS, error: null }),
      };

      return chain;
    },
    rpc: () => ({ single: () => Promise.resolve({ data: SUMMARY_ROW, error: null }) }),
  } as unknown as UserClient;
}

function deps(plans: PlanResult[]) {
  const queue = [...plans];
  const recorded: unknown[] = [];

  const plan = vi.fn<AnthropicClient["plan"]>((input) => {
    const next = queue.shift();

    if (next === undefined) throw new Error("plan chamado além do esperado");

    // Simula o streaming dos blocos de texto desta rodada.
    for (const block of next.blocks) {
      if (block.type === "text") input.onText(block.text);
    }

    return Promise.resolve(next);
  });

  const copilot = {
    db: {
      from: () => ({
        insert: (row: unknown) => {
          recorded.push(row);

          return Promise.resolve({ error: null });
        },
      }),
    },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    createUserClient: () => fakeUserClient(),
    anthropic: { narrate: vi.fn(), plan },
  } as unknown as CopilotDeps;

  return { copilot, plan, recorded };
}

async function run(plans: PlanResult[], message = "como foram as vendas?") {
  const { copilot, plan, recorded } = deps(plans);
  const events: CopilotChatEvent[] = [];

  await runCopilotChat(copilot, CALLER, "token", { message }, (event) => {
    events.push(event);

    return Promise.resolve();
  });

  return { events, plan, recorded };
}

const finalText = (text: string): PlanResult => ({
  blocks: [{ type: "text", text }],
  stopReason: "end_turn",
  costUsd: 0.001,
});

describe("runCopilotChat (D-114)", () => {
  it("resposta direta: texto flui como delta e termina em done", async () => {
    const { events } = await run([finalText("Vendemos 10 unidades nos últimos 7 dias.")]);

    expect(events).toEqual([
      { type: "text", delta: "Vendemos 10 unidades nos últimos 7 dias." },
      { type: "done", toolsUsed: [] },
    ]);
  });

  it("rodada de tool_use executa a ferramenta REAL e alimenta o modelo", async () => {
    const { events, plan } = await run([
      {
        blocks: [
          { type: "text", text: "Vou consultar. " },
          {
            type: "tool_use",
            id: "tu-1",
            name: "sales_summary",
            input: { dateFrom: "2026-08-21", dateTo: "2026-08-28" },
          },
        ],
        stopReason: "tool_use",
        costUsd: 0.001,
      },
      finalText("Foram 10 unidades e R$ 1.000,00."),
    ]);

    expect(events).toContainEqual({ type: "tool", name: "sales_summary" });
    expect(events.at(-1)).toEqual({ type: "done", toolsUsed: ["sales_summary"] });

    // A segunda rodada recebeu o RESULTADO da consulta de verdade.
    const secondCall = plan.mock.calls[1]?.[0];
    const toolResults = JSON.stringify(secondCall?.messages.at(-1)?.content ?? "");

    expect(toolResults).toContain("unitsSold");
    expect(toolResults).toContain('"tu-1"');
  });

  it("argumento inventado pelo modelo é RECUSADO pelo mesmo Zod de /query — vira tool_result de erro", async () => {
    const { events, plan } = await run([
      {
        blocks: [
          { type: "tool_use", id: "tu-1", name: "sales_summary", input: { dateFrom: "semana passada", dateTo: "hoje" } },
        ],
        stopReason: "tool_use",
        costUsd: 0.001,
      },
      finalText("Não consegui montar o período — pode me dizer as datas?"),
    ]);

    const toolResults = JSON.stringify(plan.mock.calls[1]?.[0]?.messages.at(-1)?.content ?? "");

    expect(toolResults).toContain("is_error");
    expect(toolResults).toContain("argumentos inválidos");
    // A conversa CONTINUA — o erro volta para o modelo explicar, nunca some.
    expect(events.at(-1)?.type).toBe("done");
  });

  it("ferramenta desconhecida não derruba o chat", async () => {
    const { events } = await run([
      {
        blocks: [{ type: "tool_use", id: "tu-1", name: "hack_the_db", input: {} }],
        stopReason: "tool_use",
        costUsd: 0.001,
      },
      finalText("Não tenho essa consulta."),
    ]);

    expect(events.at(-1)?.type).toBe("done");
  });

  it("o teto de rodadas corta loop infinito com aviso, nunca em silêncio", async () => {
    const round: PlanResult = {
      blocks: [
        { type: "tool_use", id: "tu-x", name: "sales_summary", input: { dateFrom: "2026-08-21", dateTo: "2026-08-28" } },
      ],
      stopReason: "tool_use",
      costUsd: 0.001,
    };

    const { events } = await run([round, round, round, round]);

    expect(events.some((event) => event.type === "error" && event.message.includes("limite de consultas"))).toBe(true);
  });

  it("o system prompt carrega hoje, as contas do usuário e a proibição de inventar", async () => {
    const { plan } = await run([finalText("ok")]);

    const system = plan.mock.calls[0]?.[0]?.system ?? "";

    expect(system).toContain("Speedbikers loja 1: acc-1");
    expect(system).toMatch(/Hoje é \d{4}-\d{2}-\d{2}/);
    expect(system).toMatch(/Nunca invente/);
  });

  it("ai_runs soma o custo de TODAS as rodadas e registra as ferramentas usadas", async () => {
    const { recorded } = await run([
      {
        blocks: [
          { type: "tool_use", id: "tu-1", name: "sales_summary", input: { dateFrom: "2026-08-21", dateTo: "2026-08-28" } },
        ],
        stopReason: "tool_use",
        costUsd: 0.002,
      },
      finalText("resposta"),
    ]);

    const run0 = recorded[0] as { cost_usd: number; tool_names: string[]; llm_used: boolean };

    expect(run0.cost_usd).toBeCloseTo(0.003);
    expect(run0.tool_names).toEqual(["copilot_chat", "sales_summary"]);
    expect(run0.llm_used).toBe(true);
  });
});
