import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { CheckAiBudgetDeps } from "./check-ai-budget.js";
import { createCheckAiBudgetHandler } from "./check-ai-budget.js";

const ORG_ID = "11111111-0000-4000-8000-000000000001";

const ENVELOPE = {
  jobType: "maintenance.check-ai-budget",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b12",
  organizationId: ORG_ID,
  dedupeKey: `check-ai-budget:${ORG_ID}:2026-08-27`,
  attempt: 1,
  enqueuedAt: "2026-08-27T12:00:00.000Z",
};

function fakeDeps(options: {
  cost?: number | string | null;
  rpcFails?: boolean;
  budgetUsd?: number;
}): {
  deps: CheckAiBudgetDeps;
  events: Record<string, unknown>[];
  lines: string[];
  rpcCalls: { fn: string; args: Record<string, unknown> }[];
} {
  const events: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

  const db = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });

      if (fn !== "get_ai_monthly_cost_usd") {
        throw new Error(`rpc inesperada no fake: ${fn}`);
      }

      return Promise.resolve(
        options.rpcFails === true
          ? { data: null, error: { message: "boom" } }
          : { data: options.cost ?? 0, error: null },
      );
    },
    from: (table: string) => {
      if (table === "domain_events") {
        return {
          upsert: (row: Record<string, unknown>) => {
            events.push(row);

            return Promise.resolve({ error: null });
          },
        };
      }

      throw new Error(`tabela inesperada no fake: ${table}`);
    },
  } as unknown as CheckAiBudgetDeps["db"];

  return {
    events,
    lines,
    rpcCalls,
    deps: {
      db,
      budgetUsd: options.budgetUsd ?? 18,
      // 27/08 no fuso de São Paulo — o mês de negócio esperado é 2026-08.
      now: () => new Date("2026-08-27T12:00:00.000-03:00"),
    },
  };
}

function ctx(lines: string[], payload: unknown): { logger: ReturnType<typeof createLogger>; payload: unknown } {
  return { logger: createLogger({}, { sink: (line) => lines.push(line) }), payload };
}

describe("aviso de orçamento de IA (D-100)", () => {
  it("dentro do teto: done com zero, nada gravado", async () => {
    const { deps, events, lines } = fakeDeps({ cost: 5.42 });

    const outcome = await createCheckAiBudgetHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(events).toHaveLength(0);
  });

  it("acima do teto: grava ai.budget.exceeded importante, organizacional (sem ml_account_id), com dedup por mês", async () => {
    const { deps, events, lines } = fakeDeps({ cost: 20.5 });

    const outcome = await createCheckAiBudgetHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ml_account_id: null,
      event_type: "ai.budget.exceeded",
      severity: "importante",
      source: "system",
      dedup_key: `ai-budget:${ORG_ID}:2026-08`,
    });
  });

  it("consulta o mês de NEGÓCIO (São Paulo) em intervalo meio-aberto a partir do dia 1", async () => {
    const { deps, lines, rpcCalls } = fakeDeps({ cost: 0 });

    await createCheckAiBudgetHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.args).toMatchObject({
      p_organization_id: ORG_ID,
      p_from: "2026-08-01T00:00:00-03:00",
    });
  });

  it("numeric chegando como string do PostgREST é interpretado, não concatenado", async () => {
    const { deps, events, lines } = fakeDeps({ cost: "19.75" });

    const outcome = await createCheckAiBudgetHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(events[0]).toMatchObject({ event_type: "ai.budget.exceeded" });
  });

  it("soma nula (nenhuma linha no mês) é custo zero, não erro", async () => {
    const { deps, events, lines } = fakeDeps({ cost: null });

    const outcome = await createCheckAiBudgetHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(events).toHaveLength(0);
  });

  it("falha na RPC é retryable", async () => {
    const { deps, lines } = fakeDeps({ rpcFails: true });

    const outcome = await createCheckAiBudgetHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("payload sem organizationId é falha definitiva", async () => {
    const { deps, lines } = fakeDeps({});

    const outcome = await createCheckAiBudgetHandler(deps)(ENVELOPE, ctx(lines, { nada: true }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });
});
