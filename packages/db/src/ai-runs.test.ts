import { describe, expect, it, vi } from "vitest";

import type { AdminClient } from "./admin-client.js";
import type { AiRunInsert } from "./ai-runs.js";
import { recordAiRun } from "./ai-runs.js";

const RUN: AiRunInsert = {
  organization_id: "00000000-0000-4000-8000-000000000000",
  user_id: "11111111-1111-4111-8111-111111111111",
  tool_names: ["sales_summary"],
  scope: { dateFrom: "2026-08-01", dateTo: "2026-08-24" },
  llm_used: false,
  cost_usd: null,
  latency_ms: 42,
};

/** Cliente mínimo com o formato que `recordAiRun` usa. */
function fakeClient(insert: () => Promise<{ error: { message: string } | null }>): {
  client: AdminClient;
  from: ReturnType<typeof vi.fn>;
} {
  const from = vi.fn(() => ({ insert }));

  return { client: { from } as unknown as AdminClient, from };
}

describe("recordAiRun", () => {
  it("grava na tabela ai_runs", async () => {
    const { client, from } = fakeClient(() => Promise.resolve({ error: null }));

    await recordAiRun(client, RUN);

    expect(from).toHaveBeenCalledWith("ai_runs");
  });

  it("devolve ok quando a gravação funciona", async () => {
    const { client } = fakeClient(() => Promise.resolve({ error: null }));

    expect(await recordAiRun(client, RUN)).toEqual({ ok: true });
  });

  it("NÃO lança quando a gravação falha", async () => {
    // Mesma garantia de recordJobRun: a ferramenta já calculou a resposta,
    // uma falha ao registrar custo/latência não pode virar erro pro
    // usuário que só queria a consulta.
    const { client } = fakeClient(() => Promise.resolve({ error: { message: "connection reset" } }));

    await expect(recordAiRun(client, RUN)).resolves.toEqual({ ok: false, reason: "connection reset" });
  });

  it("grava exatamente uma vez por chamada", async () => {
    const insert = vi.fn(() => Promise.resolve({ error: null }));
    const { client } = fakeClient(insert);

    await recordAiRun(client, RUN);

    expect(insert).toHaveBeenCalledTimes(1);
  });
});
