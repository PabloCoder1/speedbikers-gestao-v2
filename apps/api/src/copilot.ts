import type { AdminClient, UserClient } from "@sb/db";
import { recordAiRun } from "@sb/db";
import { previousBusinessDateRange } from "@sb/domain";
import type {
  CopilotQueryRequest,
  CopilotToolName,
  SalesAccountComparisonInput,
  SalesAccountComparisonOutput,
  SalesPeriodComparisonInput,
  SalesPeriodComparisonOutput,
  SalesSummary,
  SalesSummaryInput,
  SalesSummaryOutput,
} from "@sb/contracts";
import {
  salesAccountComparisonInputSchema,
  salesPeriodComparisonInputSchema,
  salesSummaryInputSchema,
} from "@sb/contracts";
import type { Logger } from "@sb/observability";
import type { ZodType } from "zod";

import type { Caller } from "./auth.js";

/**
 * `POST /v1/copilot/query` (`docs/API.md` secao 2, `docs/COPILOT.md`).
 *
 * Só o caminho de CURTO-CIRCUITO desta primeira fatia (Fase 7, item 7,
 * D-077): a ferramenta responde por completo, o LLM nunca é chamado
 * (`docs/COPILOT.md` secao 2). O "planner" que escolheria a ferramenta a
 * partir de linguagem natural fica para quando o modelo/orçamento forem
 * decididos (secao 10, pendência explícita) — por ora o chamador informa
 * `tool` diretamente.
 *
 * Cada ferramenta roda sob a RLS do usuário de verdade, não RBAC
 * reimplementado em código: `deps.createUserClient(accessToken)` devolve
 * um cliente autenticado como o chamador (`@sb/db`, `createUserClient`) —
 * `get_sales_summary` é `security invoker`, então a mesma
 * `has_account_access` que já protege a leitura em `apps/web` protege
 * aqui, sem segunda implementação (`docs/COPILOT.md` secao 3, regra 2).
 */

export class CopilotToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopilotToolError";
  }
}

export interface CopilotDeps {
  db: AdminClient;
  logger: Logger;
  createUserClient: (accessToken: string) => UserClient;
}

interface RawSalesSummaryRow {
  units_sold: number;
  gross_revenue: number;
  orders_count: number;
  purchases_count: number;
  average_ticket: number | null;
  average_selling_price: number | null;
  last_computed_at: string | null;
}

function toSalesSummary(row: RawSalesSummaryRow): SalesSummary {
  return {
    unitsSold: row.units_sold,
    grossRevenue: row.gross_revenue,
    ordersCount: row.orders_count,
    purchasesCount: row.purchases_count,
    averageTicket: row.average_ticket,
    averageSellingPrice: row.average_selling_price,
    lastComputedAt: row.last_computed_at,
  };
}

/** Mesma RPC que `apps/web/app/vendas/page.tsx` já chama — nenhuma agregação nova, só um contrato tipado por cima. */
async function fetchSalesSummary(
  userClient: UserClient,
  dateFrom: string,
  dateTo: string,
  mlAccountId?: string,
): Promise<SalesSummary> {
  const { data, error } = await userClient
    .rpc("get_sales_summary", {
      p_date_from: dateFrom,
      p_date_to: dateTo,
      ...(mlAccountId !== undefined ? { p_ml_account_id: mlAccountId } : {}),
    })
    .single();

  if (error !== null) {
    throw new CopilotToolError(error.message);
  }

  // `types.ts` marca os campos da RPC como não nuláveis, mas
  // `average_ticket`/`average_selling_price`/`last_computed_at` podem vir
  // `null` de verdade (`nullif` no SQL, "nunca calculado") — `RawSalesSummaryRow`
  // documenta a nulabilidade real; nenhum cast é necessário para atribuir
  // aqui porque `number` já é subtipo de `number | null`.
  return toSalesSummary(data);
}

export async function runSalesSummary(
  userClient: UserClient,
  input: SalesSummaryInput,
): Promise<SalesSummaryOutput> {
  return fetchSalesSummary(userClient, input.dateFrom, input.dateTo, input.mlAccountId);
}

/** Mesmo par "período atual + período anterior de igual tamanho" já usado em `/vendas` (`previousBusinessDateRange`, `@sb/domain`). */
export async function runSalesPeriodComparison(
  userClient: UserClient,
  input: SalesPeriodComparisonInput,
): Promise<SalesPeriodComparisonOutput> {
  const previousRange = previousBusinessDateRange(input.dateFrom, input.dateTo);

  const [current, previous] = await Promise.all([
    fetchSalesSummary(userClient, input.dateFrom, input.dateTo, input.mlAccountId),
    fetchSalesSummary(userClient, previousRange.from, previousRange.to, input.mlAccountId),
  ]);

  return {
    current,
    previous,
    previousRange: { dateFrom: previousRange.from, dateTo: previousRange.to },
  };
}

export async function runSalesAccountComparison(
  userClient: UserClient,
  input: SalesAccountComparisonInput,
): Promise<SalesAccountComparisonOutput> {
  const accounts = await Promise.all(
    input.mlAccountIds.map(async (mlAccountId) => ({
      mlAccountId,
      summary: await fetchSalesSummary(userClient, input.dateFrom, input.dateTo, mlAccountId),
    })),
  );

  return { accounts };
}

interface ToolDefinition {
  inputSchema: ZodType;
  run: (userClient: UserClient, input: never) => Promise<unknown>;
}

const TOOLS: Record<CopilotToolName, ToolDefinition> = {
  sales_summary: {
    inputSchema: salesSummaryInputSchema,
    run: runSalesSummary,
  },
  sales_period_comparison: {
    inputSchema: salesPeriodComparisonInputSchema,
    run: runSalesPeriodComparison,
  },
  sales_account_comparison: {
    inputSchema: salesAccountComparisonInputSchema,
    run: runSalesAccountComparison,
  },
};

export type CopilotQueryOutcome =
  | { status: 200; body: { tool: CopilotToolName; escopo: unknown; confianca: "alta"; data: unknown } }
  | { status: 400; body: { error: { code: string; message: string } } }
  | { status: 502; body: { error: { code: string; message: string } } };

/**
 * Ponto único de despacho: valida o input com o schema da ferramenta,
 * executa sob a RLS do chamador, mede latência e grava `ai_runs` —
 * **mesmo quando a gravação falha, a resposta já calculada é devolvida**
 * (`recordAiRun` nunca lança, mesmo raciocínio de `recordJobRun`:
 * observabilidade não pode ditar o resultado da operação que observa).
 */
export async function handleCopilotQuery(
  deps: CopilotDeps,
  caller: Caller,
  accessToken: string,
  request: CopilotQueryRequest,
): Promise<CopilotQueryOutcome> {
  const definition = TOOLS[request.tool];

  const parsedInput = definition.inputSchema.safeParse(request.input);

  if (!parsedInput.success) {
    return {
      status: 400,
      body: { error: { code: "invalid_payload", message: "input inválido para esta ferramenta" } },
    };
  }

  const userClient = deps.createUserClient(accessToken);
  const startedAt = Date.now();

  let data: unknown;

  try {
    data = await definition.run(userClient, parsedInput.data as never);
  } catch (error) {
    const message = error instanceof CopilotToolError ? error.message : "falha ao executar a ferramenta";

    deps.logger.error("copilot_tool_failed", { tool: request.tool, error });

    return { status: 502, body: { error: { code: "tool_failed", message } } };
  }

  const latencyMs = Date.now() - startedAt;

  const recorded = await recordAiRun(deps.db, {
    organization_id: caller.organizationId,
    user_id: caller.userId,
    tool_names: [request.tool],
    scope: parsedInput.data as Record<string, unknown>,
    llm_used: false,
    cost_usd: null,
    latency_ms: latencyMs,
  });

  if (!recorded.ok) {
    deps.logger.warn("ai_run_record_failed", { tool: request.tool, reason: recorded.reason });
  }

  return {
    status: 200,
    body: { tool: request.tool, escopo: parsedInput.data, confianca: "alta", data },
  };
}
