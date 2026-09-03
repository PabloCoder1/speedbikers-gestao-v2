import type { AdminClient, UserClient } from "@sb/db";
import { createLogger } from "@sb/observability";
import { describe, expect, it, vi } from "vitest";

import type { AnthropicClient } from "./anthropic-client.js";
import type { Caller } from "./auth.js";
import {
  CopilotToolError,
  handleCopilotQuery,
  runNarrateAction,
  runNarrateSkuDiagnosis,
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

  /**
   * O recorte de marca de D-237 fez `purchases_count` virar anulável na RPC.
   * O Copiloto NÃO recorta por marca, então para ele o campo nunca é nulo — e
   * os dois testes abaixo são as duas metades dessa afirmação: a chamada não
   * manda os parâmetros de marca, e se mesmo assim vier nulo a ferramenta
   * estoura em vez de narrar um número inventado.
   */
  it("não recorta por marca: a chamada não manda p_supplier_brand nem p_sem_marca", async () => {
    const { userClient, calls } = fakeUserClient([{ data: SUMMARY_ROW, error: null }]);

    await runSalesSummary(userClient, { dateFrom: "2026-08-01", dateTo: "2026-08-24" });

    expect(calls[0]?.args).not.toHaveProperty("p_supplier_brand");
    expect(calls[0]?.args).not.toHaveProperty("p_sem_marca");
  });

  it("purchases_count nulo estoura em vez de virar zero — só acontece sob recorte, que esta ferramenta não faz (D-237)", async () => {
    const { userClient } = fakeUserClient([{ data: { ...SUMMARY_ROW, purchases_count: null }, error: null }]);

    await expect(runSalesSummary(userClient, { dateFrom: "2026-08-01", dateTo: "2026-08-24" })).rejects.toThrow(
      /purchases_count nulo/,
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

describe("runNarrateSkuDiagnosis", () => {
  const DIAGNOSIS_INPUT = {
    diagnosis: {
      escopo: { organizationId: "org-1", skuId: "sku-1" },
      periodo: { asOf: "2026-08-24" },
      direcao: "queda" as const,
      confianca: "alta" as const,
      zScore: -3.2,
      unitsDelta: -8,
      evidencias: [{ tipo: "venda_atual", descricao: "Vendeu 2 unidades ontem, média esperada era 10." }],
      causasCandidatas: [
        { eventType: "listing.status.paused", occurredAt: "2026-08-23T10:00:00.000Z", descricao: "Anúncio pausado." },
      ],
      proximosPassos: ["Verificar se o anúncio deveria estar pausado."],
    },
    impactBrl: -400,
  };

  /** Fake de `UserClient` só para `.from("skus").select(...).eq(...).maybeSingle()` — a checagem de RLS que a narração faz antes de chamar o LLM. */
  function fakeUserClientForSku(sku: { id: string } | null): UserClient {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: sku, error: null }),
          }),
        }),
      }),
    } as unknown as UserClient;
  }

  it("recusa quando o SKU não é encontrado sob a RLS do usuário", async () => {
    const userClient = fakeUserClientForSku(null);
    const anthropic: AnthropicClient = { narrate: vi.fn(), plan: vi.fn() };

    await expect(runNarrateSkuDiagnosis(userClient, DIAGNOSIS_INPUT, anthropic)).rejects.toThrow(CopilotToolError);
    expect(anthropic.narrate).not.toHaveBeenCalled();
  });

  it("narra citando o contrato e devolve o custo real devolvido pelo modelo", async () => {
    const userClient = fakeUserClientForSku({ id: "sku-1" });
    const narrate = vi.fn<AnthropicClient["narrate"]>(() =>
      Promise.resolve({ text: "Queda de venda confirmada.", costUsd: 0.00042 }),
    );
    const anthropic: AnthropicClient = { narrate, plan: vi.fn() };

    const result = await runNarrateSkuDiagnosis(userClient, DIAGNOSIS_INPUT, anthropic);

    expect(result).toEqual({ data: { narrativa: "Queda de venda confirmada." }, costUsd: 0.00042 });
    const call = narrate.mock.calls[0]?.[0];
    expect(call?.prompt).toContain("Vendeu 2 unidades ontem");
    expect(call?.prompt).toContain("Anúncio pausado");
  });
});

describe("runNarrateAction", () => {
  /** Fake de `UserClient` para `.from("actions").select(...).eq(...).maybeSingle()` — a leitura sob RLS que é autorização e dado no mesmo ato. */
  function fakeUserClientForAction(row: Record<string, unknown> | null): UserClient {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: row, error: null }),
          }),
        }),
      }),
    } as unknown as UserClient;
  }

  const ACTION_ROW = {
    kind: "venda_anomala",
    confidence: "alta",
    estimated_impact_brl: -400,
    evidence: {
      direcao: "queda",
      evidencias: [{ tipo: "venda_vs_baseline", descricao: "Vendeu 14 unidades a menos que o esperado." }],
      causas_candidatas: [
        {
          event_type: "listing.status.paused",
          occurred_at: "2026-08-30T10:00:00.000Z",
          descricao: "Anúncio pausado dois dias antes.",
        },
      ],
    },
    recommendation: "Investigar por que o anúncio foi pausado.",
    skus: { sku: "5821", title: "Manete esportivo" },
  };

  it("recusa quando a ação não é encontrada sob a RLS do usuário — o LLM nunca é chamado", async () => {
    const userClient = fakeUserClientForAction(null);
    const anthropic: AnthropicClient = { narrate: vi.fn(), plan: vi.fn() };

    await expect(
      runNarrateAction(userClient, { actionId: "00000000-0000-4000-8000-000000000009" }, anthropic),
    ).rejects.toThrow(CopilotToolError);
    expect(anthropic.narrate).not.toHaveBeenCalled();
  });

  it("monta o prompt pela MESMA leitura da tela e exige o vocabulário obrigatório no system prompt", async () => {
    const userClient = fakeUserClientForAction(ACTION_ROW);
    const narrate = vi.fn<AnthropicClient["narrate"]>(() =>
      Promise.resolve({ text: "Causa mais provável: anúncio pausado.", costUsd: 0.0007 }),
    );
    const anthropic: AnthropicClient = { narrate, plan: vi.fn() };

    const result = await runNarrateAction(userClient, { actionId: "00000000-0000-4000-8000-000000000009" }, anthropic);

    expect(result).toEqual({ data: { narrativa: "Causa mais provável: anúncio pausado." }, costUsd: 0.0007 });

    const call = narrate.mock.calls[0]?.[0];

    // Prompt: só o que está na linha — evidência, causa datada, recomendação, SKU.
    expect(call?.prompt).toContain("Vendeu 14 unidades a menos");
    expect(call?.prompt).toContain("Anúncio pausado dois dias antes");
    expect(call?.prompt).toContain("Investigar por que o anúncio foi pausado.");
    expect(call?.prompt).toContain("5821");

    // Vocabulário obrigatório do PRD (D-155) — as cinco seções, e a proibição.
    expect(call?.system).toContain("Causa mais provável:");
    expect(call?.system).toContain("Fatores contribuintes:");
    expect(call?.system).toContain("Hipóteses:");
    expect(call?.system).toContain("Evidências contrárias:");
    expect(call?.system).toContain("O que não conseguimos verificar:");
    expect(call?.system).toContain('"causa verdadeira"');
  });

  it("ação de SAC (sem direção, sem causas) degrada honestamente — o prompt declara a ausência", async () => {
    const userClient = fakeUserClientForAction({
      kind: "reclamacoes_recorrentes",
      confidence: "alta",
      estimated_impact_brl: null,
      evidence: { evidencias: [{ tipo: "reclamacoes_abertas", descricao: "3 reclamações abertas no SKU." }] },
      recommendation: "Abrir a Caixa de Entrada.",
      skus: null,
    });
    const narrate = vi.fn<AnthropicClient["narrate"]>(() => Promise.resolve({ text: "Narrativa.", costUsd: 0.0002 }));
    const anthropic: AnthropicClient = { narrate, plan: vi.fn() };

    await runNarrateAction(userClient, { actionId: "00000000-0000-4000-8000-000000000009" }, anthropic);

    const call = narrate.mock.calls[0]?.[0];

    expect(call?.prompt).toContain("Reclamações recorrentes");
    expect(call?.prompt).toContain("nenhuma causa candidata encontrada");
    expect(call?.prompt).toContain("sem SKU vinculado");
    expect(call?.prompt).toContain("Impacto estimado: desconhecido");
  });
});

describe("handleCopilotQuery", () => {
  function fakeDb(insert: () => Promise<{ error: { message: string } | null }>): AdminClient {
    return { from: () => ({ insert }) } as unknown as AdminClient;
  }

  const fakeAnthropic: AnthropicClient = {
    narrate: () => Promise.reject(new Error("não deveria ser chamado por esta ferramenta")),
    plan: () => Promise.reject(new Error("não deveria ser chamado por esta ferramenta")),
  };

  it("400 quando o input não bate com o schema da ferramenta", async () => {
    const { userClient } = fakeUserClient([]);
    const deps = { db: fakeDb(() => Promise.resolve({ error: null })), logger: createLogger({}, { sink: () => undefined }), createUserClient: () => userClient, anthropic: fakeAnthropic };

    const outcome = await handleCopilotQuery(deps, CALLER, "token", {
      tool: "sales_summary",
      input: { dateFrom: "não é uma data" },
    });

    expect(outcome.status).toBe(400);
  });

  it("200 com o card completo quando a ferramenta responde — escopo e confiança presentes", async () => {
    const { userClient } = fakeUserClient([{ data: SUMMARY_ROW, error: null }]);
    const deps = { db: fakeDb(() => Promise.resolve({ error: null })), logger: createLogger({}, { sink: () => undefined }), createUserClient: () => userClient, anthropic: fakeAnthropic };

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
    const deps = { db: fakeDb(() => Promise.resolve({ error: null })), logger: createLogger({}, { sink: () => undefined }), createUserClient: () => userClient, anthropic: fakeAnthropic };

    const outcome = await handleCopilotQuery(deps, CALLER, "token", {
      tool: "sales_summary",
      input: { dateFrom: "2026-08-01", dateTo: "2026-08-24" },
    });

    expect(outcome.status).toBe(502);
  });

  it("grava ai_runs com llm_used=false e a ferramenta usada", async () => {
    const { userClient } = fakeUserClient([{ data: SUMMARY_ROW, error: null }]);
    const insert = vi.fn(() => Promise.resolve({ error: null }));
    const deps = { db: fakeDb(insert), logger: createLogger({}, { sink: () => undefined }), createUserClient: () => userClient, anthropic: fakeAnthropic };

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

  it("grava ai_runs com llm_used=true e o custo real para narrate_sku_diagnosis", async () => {
    const userClient = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: "sku-1" }, error: null }) }) }),
      }),
    } as unknown as UserClient;
    const insert = vi.fn(() => Promise.resolve({ error: null }));
    const anthropic: AnthropicClient = { narrate: () => Promise.resolve({ text: "Narrativa.", costUsd: 0.001 }), plan: vi.fn() };
    const deps = {
      db: fakeDb(insert),
      logger: createLogger({}, { sink: () => undefined }),
      createUserClient: () => userClient,
      anthropic,
    };

    await handleCopilotQuery(deps, CALLER, "token", {
      tool: "narrate_sku_diagnosis",
      input: {
        diagnosis: {
          escopo: {
            organizationId: "00000000-0000-4000-8000-000000000001",
            skuId: "00000000-0000-4000-8000-000000000002",
          },
          periodo: { asOf: "2026-08-24" },
          direcao: "queda",
          confianca: "alta",
          zScore: -3.2,
          unitsDelta: -8,
          evidencias: [],
          causasCandidatas: [],
          proximosPassos: [],
        },
        impactBrl: null,
      },
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ tool_names: ["narrate_sku_diagnosis"], llm_used: true, cost_usd: 0.001 }),
    );
  });

  it("NÃO falha a resposta quando a gravação de ai_runs falha — a consulta já funcionou", async () => {
    const { userClient } = fakeUserClient([{ data: SUMMARY_ROW, error: null }]);
    const deps = {
      db: fakeDb(() => Promise.resolve({ error: { message: "connection reset" } })),
      logger: createLogger({}, { sink: () => undefined }),
      createUserClient: () => userClient,
      anthropic: fakeAnthropic,
    };

    const outcome = await handleCopilotQuery(deps, CALLER, "token", {
      tool: "sales_summary",
      input: { dateFrom: "2026-08-01", dateTo: "2026-08-24" },
    });

    expect(outcome.status).toBe(200);
  });
});
