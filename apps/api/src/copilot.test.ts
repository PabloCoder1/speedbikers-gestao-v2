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
  runListingPerformance,
  runSalesSummary,
  runSkuReplenishment,
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


/**
 * As DUAS FERRAMENTAS ALÉM DE VENDA (D-293) — a pré-condição que D-276
 * escreveu para a gaveta do Copiloto.
 */

/**
 * Fake para as ferramentas novas: elas usam `.rpc(...)` SEM `.single()` e
 * `.from(...).select(...)`, ao contrário das de venda.
 */
function fakeStockClient(input: {
  suggestions: { data: unknown; error: { message: string } | null };
  settings: { data: unknown; error: { message: string } | null };
}): { userClient: UserClient; calls: RpcCall[] } {
  const calls: RpcCall[] = [];

  const client = {
    rpc: vi.fn((name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });

      return Promise.resolve(input.suggestions);
    }),
    from: vi.fn(() => ({ select: () => Promise.resolve(input.settings) })),
  };

  return { userClient: client as unknown as UserClient, calls };
}

const LINHA_SKU = {
  sku_id: "11111111-1111-4111-8111-111111111111",
  sku: "SB-001",
  title: "Pneu 29",
  supplier_brand: "VAZ",
  abc_class: "A",
  local_quantity: 30,
  full_quantity: 10,
  transito: 5,
  reservado: 4,
  stock_is_virtual: false,
  units_15d: 45,
  units_30d: 90,
  units_60d: 180,
  units_90d: 270,
  history_days_90: 90,
  purchase_cost: 50,
  coverage_days: 15,
  state: "COMPRAR_EM_BREVE",
  suggested_quantity: 90,
  total_count: 1,
};

const CONFIG_PADRAO = {
  supplier_brand: null,
  sku_id: null,
  lead_time_days: 10,
  target_coverage_days: 30,
  safety_stock_days: 5,
  max_coverage_days: null,
  policy_note: null,
};

describe("runSkuReplenishment (D-293)", () => {
  it("compõe o veredito pelas peças canônicas e devolve a decomposição inteira", async () => {
    const { userClient, calls } = fakeStockClient({
      suggestions: { data: [LINHA_SKU], error: null },
      settings: { data: [CONFIG_PADRAO], error: null },
    });

    const result = await runSkuReplenishment(userClient, { sku: "SB-001" }, "org-1");

    expect(calls[0]?.name).toBe("get_purchase_suggestions");
    expect(calls[0]?.args.p_organization_id).toBe("org-1");
    expect(calls[0]?.args.p_search).toBe("SB-001");

    // Os mesmos números que `/reposicao` mostra, porque é a MESMA composição.
    expect(result.usableStock).toBe(45);
    expect(result.coverageDays).toBe(15);
    expect(result.state).toBe("COMPRAR_EM_BREVE");
    expect(result.suggestedQuantity).toBe(90);
    expect(result.policy?.scope).toBe("PADRAO");
    expect(result.refusals).toEqual([]);
  });

  /*
    `p_search` casa SKU **ou** título, então "SB-001" traz "SB-0010" junto.
    Responder sobre o SKU errado com toda a confiança do mundo é o defeito que
    este caso existe para impedir.
  */
  it("exige casamento EXATO do código — prefixo não serve", async () => {
    const { userClient } = fakeStockClient({
      suggestions: { data: [{ ...LINHA_SKU, sku: "SB-0010" }], error: null },
      settings: { data: [CONFIG_PADRAO], error: null },
    });

    await expect(runSkuReplenishment(userClient, { sku: "SB-001" }, "org-1")).rejects.toBeInstanceOf(
      CopilotToolError,
    );
  });

  /*
    A recusa viaja JUNTO do nulo: sem ela o modelo lê "coverageDays: null" como
    zero e narra ruptura onde há saldo sentinela (D-127).
  */
  it("SKU virtual devolve nulo COM a recusa ao lado", async () => {
    const { userClient } = fakeStockClient({
      suggestions: { data: [{ ...LINHA_SKU, stock_is_virtual: true }], error: null },
      settings: { data: [CONFIG_PADRAO], error: null },
    });

    const result = await runSkuReplenishment(userClient, { sku: "SB-001" }, "org-1");

    expect(result.usableStock).toBeNull();
    expect(result.coverageDays).toBeNull();
    expect(result.refusals).toContain("ESTOQUE_VIRTUAL");
  });

  it("sem configuração de reposição, a sugestão recusa e a cobertura continua", async () => {
    const { userClient } = fakeStockClient({
      suggestions: { data: [LINHA_SKU], error: null },
      settings: { data: [], error: null },
    });

    const result = await runSkuReplenishment(userClient, { sku: "SB-001" }, "org-1");

    expect(result.suggestedQuantity).toBeNull();
    expect(result.refusals).toContain("SEM_CONFIGURACAO");
    expect(result.coverageDays).toBe(15);
    expect(result.policy).toBeNull();
  });
});

/** Fake para `listing_performance`: `.rpc(...).single()` mais um `.from(...)` encadeado. */
function fakeListingClient(input: {
  summary: { data: unknown; error: { message: string } | null };
  listing: { data: unknown; error: { message: string } | null };
}): { userClient: UserClient; calls: RpcCall[] } {
  const calls: RpcCall[] = [];

  const client = {
    rpc: vi.fn((name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });

      return { single: () => Promise.resolve(input.summary) };
    }),
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(input.listing) }) }),
      }),
    })),
  };

  return { userClient: client as unknown as UserClient, calls };
}

describe("runListingPerformance (D-293)", () => {
  const RESUMO = {
    visits: 120,
    units_sold: 6,
    orders_count: 6,
    gross_revenue: 900,
    conversion: 0.05,
    days_observed: 30,
  };

  it("junta desempenho e cadastro do anúncio numa resposta só", async () => {
    const { userClient, calls } = fakeListingClient({
      summary: { data: RESUMO, error: null },
      listing: { data: { title: "Pneu 29", status: "active", price: 150, available_quantity: 3 }, error: null },
    });

    const result = await runListingPerformance(
      userClient,
      { itemId: "MLB1", mlAccountId: "22222222-2222-4222-8222-222222222222", dateFrom: "2026-08-01", dateTo: "2026-08-30" },
      "org-1",
    );

    expect(calls[0]?.args.p_organization_id).toBe("org-1");
    expect(result.visits).toBe(120);
    expect(result.conversion).toBe(0.05);
    expect(result.title).toBe("Pneu 29");
    expect(result.price).toBe(150);
  });

  /* Sem visita não há denominador: conversão é NULA, nunca 0% (D-123). */
  it("conversão nula atravessa como nula", async () => {
    const { userClient } = fakeListingClient({
      summary: { data: { ...RESUMO, visits: 0, conversion: null }, error: null },
      listing: { data: null, error: null },
    });

    const result = await runListingPerformance(
      userClient,
      { itemId: "MLB1", mlAccountId: "22222222-2222-4222-8222-222222222222", dateFrom: "2026-08-01", dateTo: "2026-08-30" },
      "org-1",
    );

    expect(result.conversion).toBeNull();
    expect(result.visits).toBe(0);
    // Anúncio fora do cadastro não inventa título nem preço.
    expect(result.title).toBeNull();
    expect(result.price).toBeNull();
  });
});
