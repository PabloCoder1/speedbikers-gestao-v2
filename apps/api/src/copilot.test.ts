import type { AdminClient, UserClient } from "@sb/db";
import { createLogger } from "@sb/observability";
import { describe, expect, it, vi } from "vitest";

import type { Caller } from "./auth.js";
import {
  CopilotToolError,
  handleCopilotQuery,
  runSalesAccountComparison,
  runSalesPeriodComparison,
  runSalesSummary,
} from "./copilot.js";

const CALLER: Caller = { userId: "u1", organizationId: "org-1", role: "ANALISTA" };

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

/** Fake mínimo de `UserClient`: registra as chamadas de `.rpc(...).single()` e responde na ordem dada. */
function fakeUserClient(
  responses: { data: unknown; error: { message: string } | null }[],
): { userClient: UserClient; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  let index = 0;

  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const response = responses[index] ?? { data: null, error: { message: "sem resposta configurada" } };
    index += 1;

    return { single: () => Promise.resolve(response) };
  });

  return { userClient: { rpc } as unknown as UserClient, calls };
}

const SUMMARY_ROW = {
  units_sold: 10,
  gross_revenue: 1000,
  orders_count: 5,
  purchases_count: 5,
  average_ticket: 200,
  average_selling_price: 100,
  last_computed_at: "2026-08-24T10:00:00.000Z",
};

describe("runSalesSummary", () => {
  it("mapeia o retorno snake_case da RPC para o contrato camelCase", async () => {
    const { userClient } = fakeUserClient([{ data: SUMMARY_ROW, error: null }]);

    const result = await runSalesSummary(userClient, { dateFrom: "2026-08-01", dateTo: "2026-08-24" });

    expect(result).toEqual({
      unitsSold: 10,
      grossRevenue: 1000,
      ordersCount: 5,
      purchasesCount: 5,
      averageTicket: 200,
      averageSellingPrice: 100,
      lastComputedAt: "2026-08-24T10:00:00.000Z",
    });
  });

  it("passa p_ml_account_id só quando informado", async () => {
    const { userClient, calls } = fakeUserClient([{ data: SUMMARY_ROW, error: null }]);

    await runSalesSummary(userClient, { dateFrom: "2026-08-01", dateTo: "2026-08-24", mlAccountId: "acc-1" });

    expect(calls[0]?.args).toMatchObject({ p_ml_account_id: "acc-1" });
  });

  it("omite p_ml_account_id quando ausente — grão organização, mesma semântica de get_sales_summary", async () => {
    const { userClient, calls } = fakeUserClient([{ data: SUMMARY_ROW, error: null }]);

    await runSalesSummary(userClient, { dateFrom: "2026-08-01", dateTo: "2026-08-24" });

    expect(calls[0]?.args).not.toHaveProperty("p_ml_account_id");
  });

  it("lança CopilotToolError quando a RPC falha", async () => {
    const { userClient } = fakeUserClient([{ data: null, error: { message: "permission denied" } }]);

    await expect(runSalesSummary(userClient, { dateFrom: "2026-08-01", dateTo: "2026-08-24" })).rejects.toThrow(
      CopilotToolError,
    );
  });

  it("períodos sem venda (average_ticket/average_selling_price nulos) não viram zero fingido", async () => {
    const { userClient } = fakeUserClient([
      { data: { ...SUMMARY_ROW, average_ticket: null, average_selling_price: null }, error: null },
    ]);

    const result = await runSalesSummary(userClient, { dateFrom: "2026-08-01", dateTo: "2026-08-24" });

    expect(result.averageTicket).toBeNull();
    expect(result.averageSellingPrice).toBeNull();
  });
});

describe("runSalesPeriodComparison", () => {
  it("consulta o período pedido e o período anterior de igual tamanho", async () => {
    const { userClient, calls } = fakeUserClient([
      { data: SUMMARY_ROW, error: null },
      { data: SUMMARY_ROW, error: null },
    ]);

    const result = await runSalesPeriodComparison(userClient, { dateFrom: "2026-08-15", dateTo: "2026-08-24" });

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.args.p_date_from).sort()).toEqual(["2026-08-05", "2026-08-15"]);
    expect(result.previousRange).toEqual({ dateFrom: "2026-08-05", dateTo: "2026-08-14" });
  });
});

describe("runSalesAccountComparison", () => {
  it("consulta uma vez por conta, mesmo período", async () => {
    const { userClient, calls } = fakeUserClient([
      { data: SUMMARY_ROW, error: null },
      { data: SUMMARY_ROW, error: null },
    ]);

    const result = await runSalesAccountComparison(userClient, {
      dateFrom: "2026-08-01",
      dateTo: "2026-08-24",
      mlAccountIds: ["acc-1", "acc-2"],
    });

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.args.p_date_from === "2026-08-01")).toBe(true);
    expect(result.accounts.map((account) => account.mlAccountId)).toEqual(["acc-1", "acc-2"]);
  });
});

describe("handleCopilotQuery", () => {
  function fakeDb(insert: () => Promise<{ error: { message: string } | null }>): AdminClient {
    return { from: () => ({ insert }) } as unknown as AdminClient;
  }

  it("400 quando o input não bate com o schema da ferramenta", async () => {
    const { userClient } = fakeUserClient([]);
    const deps = { db: fakeDb(() => Promise.resolve({ error: null })), logger: createLogger({}, { sink: () => undefined }), createUserClient: () => userClient };

    const outcome = await handleCopilotQuery(deps, CALLER, "token", {
      tool: "sales_summary",
      input: { dateFrom: "não é uma data" },
    });

    expect(outcome.status).toBe(400);
  });

  it("200 com o card completo quando a ferramenta responde — escopo e confiança presentes", async () => {
    const { userClient } = fakeUserClient([{ data: SUMMARY_ROW, error: null }]);
    const deps = { db: fakeDb(() => Promise.resolve({ error: null })), logger: createLogger({}, { sink: () => undefined }), createUserClient: () => userClient };

    const outcome = await handleCopilotQuery(deps, CALLER, "token", {
      tool: "sales_summary",
      input: { dateFrom: "2026-08-01", dateTo: "2026-08-24" },
    });

    expect(outcome.status).toBe(200);
    expect(outcome.status === 200 && outcome.body.confianca).toBe("alta");
    expect(outcome.status === 200 && outcome.body.tool).toBe("sales_summary");
  });

  it("502 quando a ferramenta falha ao executar", async () => {
    const { userClient } = fakeUserClient([{ data: null, error: { message: "timeout" } }]);
    const deps = { db: fakeDb(() => Promise.resolve({ error: null })), logger: createLogger({}, { sink: () => undefined }), createUserClient: () => userClient };

    const outcome = await handleCopilotQuery(deps, CALLER, "token", {
      tool: "sales_summary",
      input: { dateFrom: "2026-08-01", dateTo: "2026-08-24" },
    });

    expect(outcome.status).toBe(502);
  });

  it("grava ai_runs com llm_used=false e a ferramenta usada", async () => {
    const { userClient } = fakeUserClient([{ data: SUMMARY_ROW, error: null }]);
    const insert = vi.fn(() => Promise.resolve({ error: null }));
    const deps = { db: fakeDb(insert), logger: createLogger({}, { sink: () => undefined }), createUserClient: () => userClient };

    await handleCopilotQuery(deps, CALLER, "token", {
      tool: "sales_summary",
      input: { dateFrom: "2026-08-01", dateTo: "2026-08-24" },
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: CALLER.organizationId,
        user_id: CALLER.userId,
        tool_names: ["sales_summary"],
        llm_used: false,
        cost_usd: null,
      }),
    );
  });

  it("NÃO falha a resposta quando a gravação de ai_runs falha — a consulta já funcionou", async () => {
    const { userClient } = fakeUserClient([{ data: SUMMARY_ROW, error: null }]);
    const deps = {
      db: fakeDb(() => Promise.resolve({ error: { message: "connection reset" } })),
      logger: createLogger({}, { sink: () => undefined }),
      createUserClient: () => userClient,
    };

    const outcome = await handleCopilotQuery(deps, CALLER, "token", {
      tool: "sales_summary",
      input: { dateFrom: "2026-08-01", dateTo: "2026-08-24" },
    });

    expect(outcome.status).toBe(200);
  });
});
