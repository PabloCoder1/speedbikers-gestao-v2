import type { AdminClient, UserClient } from "@sb/db";
import { recordAiRun } from "@sb/db";
import { describeActionEvidence, previousBusinessDateRange } from "@sb/domain";
import type {
  CopilotQueryRequest,
  CopilotToolName,
  NarrateActionInput,
  NarrateActionOutput,
  NarrateSkuDiagnosisInput,
  NarrateSkuDiagnosisOutput,
  SalesAccountComparisonInput,
  SalesAccountComparisonOutput,
  SalesPeriodComparisonInput,
  SalesPeriodComparisonOutput,
  SalesSummary,
  SalesSummaryInput,
  SalesSummaryOutput,
} from "@sb/contracts";
import {
  narrateActionInputSchema,
  narrateSkuDiagnosisInputSchema,
  salesAccountComparisonInputSchema,
  salesPeriodComparisonInputSchema,
  salesSummaryInputSchema,
  structureFeatureSuggestionInputSchema,
  suggestSupportReplyInputSchema,
} from "@sb/contracts";
import type { Logger } from "@sb/observability";
import type { ZodType } from "zod";

import type { AnthropicClient } from "./anthropic-client.js";
import type { Caller } from "./auth.js";
import { runStructureFeatureSuggestion, runSuggestSupportReply } from "./copilot-generation.js";

/**
 * `POST /v1/copilot/query` (`docs/API.md` secao 2, `docs/COPILOT.md`).
 *
 * O caminho de FERRAMENTA DIRETA (Fase 7, item 7, D-077): o chamador
 * informa `tool` e o LLM só entra quando a ferramenta é de geração
 * (`docs/COPILOT.md` secao 2). O planner por linguagem natural existe desde
 * D-114 como rota IRMÃ (`POST /v1/copilot/chat`, `copilot-chat.ts`) — ele
 * escolhe entre estas mesmas ferramentas via tool use e valida os
 * argumentos com os MESMOS schemas deste arquivo.
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
  anthropic: AnthropicClient;
}

interface RawSalesSummaryRow {
  units_sold: number;
  gross_revenue: number;
  orders_count: number;
  /**
   * Anulável desde D-237: sob recorte de MARCA a RPC devolve NULL aqui, porque
   * a compra é contada por `pack` e um pack atravessa SKUs de marcas
   * diferentes — somá-la por marca contaria o mesmo pack duas vezes.
   *
   * O Copiloto NÃO recorta por marca (a chamada abaixo passa só datas e conta),
   * então na prática nunca é nulo. Quem tornar isso falso vai bater na guarda
   * de `toSalesSummary`, que é onde a decisão precisa ser tomada.
   */
  purchases_count: number | null;
  average_ticket: number | null;
  average_selling_price: number | null;
  last_computed_at: string | null;
}

function toSalesSummary(row: RawSalesSummaryRow): SalesSummary {
  // GUARDA, não cast (a lição de D-200: cast esconde qual defesa é real). O
  // contrato de saída do Copiloto (`salesSummarySchema`) declara
  // `purchasesCount` NÃO anulável, e isso é verdade enquanto a chamada não
  // recortar por marca. Se alguém acrescentar `p_supplier_brand` aqui, esta
  // linha estoura em vez de mandar um número inventado para o modelo narrar —
  // e a decisão certa passa a ser: alargar o contrato ou recusar a ferramenta
  // sob recorte.
  if (row.purchases_count === null) {
    throw new CopilotToolError(
      "get_sales_summary devolveu purchases_count nulo: isso só acontece sob recorte de marca, que esta ferramenta não faz. Alargue o contrato antes de recortar.",
    );
  }

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

/**
 * Narração de diagnóstico (`docs/COPILOT.md` secao 4/7, D-082) — o ÚNICO
 * lugar do Copiloto onde o LLM é chamado nesta fatia. `diagnoseSalesAnomaly`
 * (`@sb/domain`) já decidiu tudo: direção, confiança, evidências, causas
 * candidatas. O modelo só narra o que está em `input`, nunca produz
 * diagnóstico novo — por isso o system prompt proíbe explicitamente inventar
 * qualquer coisa fora dele.
 */
const DIAGNOSIS_NARRATION_SYSTEM_PROMPT = [
  "Você narra, em português claro e direto, um diagnóstico de anomalia de venda já calculado por um sistema determinístico separado.",
  "Regras estritas:",
  "- Cite APENAS os dados fornecidos abaixo. Nunca invente, presuma ou infira qualquer evidência, causa ou número que não esteja explicitamente presente.",
  "- Se não houver causa candidata, diga isso claramente — nunca sugira uma causa que não foi fornecida.",
  "- Nunca afirme certeza além do nível de confiança indicado.",
  "- Seja conciso: 2 a 4 frases, sem saudação nem encerramento.",
].join("\n");

const currencyFormatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function buildDiagnosisNarrationPrompt(input: NarrateSkuDiagnosisInput): string {
  const { diagnosis, impactBrl } = input;

  const evidencias =
    diagnosis.evidencias.length > 0 ? diagnosis.evidencias.map((item) => `- ${item.descricao}`).join("\n") : "nenhuma";

  const causas =
    diagnosis.causasCandidatas.length > 0
      ? diagnosis.causasCandidatas.map((cause) => `- ${cause.descricao}`).join("\n")
      : "nenhuma causa candidata encontrada";

  const proximosPassos =
    diagnosis.proximosPassos.length > 0 ? diagnosis.proximosPassos.map((step) => `- ${step}`).join("\n") : "nenhum";

  return [
    `Direção: ${diagnosis.direcao}`,
    `Confiança: ${diagnosis.confianca}`,
    `Z-score: ${diagnosis.zScore.toFixed(2)}`,
    `Impacto estimado: ${impactBrl === null ? "desconhecido" : currencyFormatter.format(impactBrl)}`,
    `Evidências:\n${evidencias}`,
    `Causas candidatas:\n${causas}`,
    `Próximos passos sugeridos:\n${proximosPassos}`,
  ].join("\n\n");
}

/**
 * Revalida sob RLS que o usuário alcança o SKU do contrato antes de narrar
 * — o contrato em si vem do chamador (já calculado no `web`, D-078), não
 * é recalculado aqui (evita duplicar a agregação pesada de
 * `get_sku_sales_baseline`/`domain_events`). O pior caso de um contrato
 * forjado é o próprio usuário gastar crédito de LLM narrando lixo sobre um
 * SKU que ele já pode ver — nunca um vazamento entre organizações, que é o
 * que a checagem abaixo impede.
 */
export async function runNarrateSkuDiagnosis(
  userClient: UserClient,
  input: NarrateSkuDiagnosisInput,
  anthropic: AnthropicClient,
): Promise<{ data: NarrateSkuDiagnosisOutput; costUsd: number }> {
  const sku = await userClient.from("skus").select("id").eq("id", input.diagnosis.escopo.skuId).maybeSingle();

  if (sku.error !== null || sku.data === null) {
    throw new CopilotToolError("SKU não encontrado ou sem permissão.");
  }

  const { text, costUsd } = await anthropic.narrate({
    system: DIAGNOSIS_NARRATION_SYSTEM_PROMPT,
    prompt: buildDiagnosisNarrationPrompt(input),
  });

  return { data: { narrativa: text }, costUsd };
}

/**
 * Explicação de AÇÃO da Central de Ações (D-155, o último item da Fase 6B) —
 * a IA explica a AÇÃO, não só o diagnóstico do SKU. O vocabulário é o
 * OBRIGATÓRIO do PRD ("Central de Ações e Diagnóstico com IA"): causa mais
 * provável, fatores contribuintes, hipóteses, evidências contrárias e o que
 * não conseguimos verificar — nunca "causa verdadeira". Seção sem dado diz
 * isso, em vez de ser preenchida com suposição: para `reclamacoes_recorrentes`
 * (D-116), que não tem direção nem causas candidatas, é esse o caminho que
 * roda sempre.
 */
const ACTION_EXPLANATION_SYSTEM_PROMPT = [
  "Você explica, em português claro e direto, uma ação já detectada por um sistema determinístico separado (a Central de Ações).",
  "Estruture a resposta EXATAMENTE nestas cinco seções, cada uma numa linha própria iniciada pelo rótulo:",
  "Causa mais provável:",
  "Fatores contribuintes:",
  "Hipóteses:",
  "Evidências contrárias:",
  "O que não conseguimos verificar:",
  "Regras estritas:",
  "- Cite APENAS os dados fornecidos abaixo. Nunca invente, presuma ou infira evidência, causa ou número que não esteja explicitamente presente.",
  '- Seção sem dado correspondente diz isso explicitamente (por exemplo: "nenhuma registrada pelo sistema") — nunca é preenchida com suposição.',
  '- Nunca use a expressão "causa verdadeira" nem afirme certeza além do nível de confiança indicado.',
  "- Sem saudação nem encerramento; cada seção tem 1 a 2 frases.",
].join("\n");

/** Forma da linha de `actions` lida sob RLS — espelho do que `/acoes` já seleciona (nulabilidade real do join). */
interface ActionRowForNarration {
  kind: string;
  confidence: string;
  estimated_impact_brl: number | null;
  evidence: unknown;
  recommendation: string;
  skus: { sku: string; title: string | null } | null;
}

function buildActionExplanationPrompt(row: ActionRowForNarration): string {
  // A MESMA leitura defensiva que a tela renderiza (`describeActionEvidence`,
  // @sb/domain) — dois leitores independentes do jsonb divergiriam na
  // primeira forma nova, e a narração citaria o que a tela não mostra.
  const view = describeActionEvidence(row.kind, row.evidence);

  const evidencias =
    view.evidencias.length > 0 ? view.evidencias.map((item) => `- ${item.descricao}`).join("\n") : "nenhuma";

  const causas =
    view.causas.length > 0
      ? view.causas.map((cause) => `- ${cause.descricao} (evento ${cause.eventType} em ${cause.occurredAt})`).join("\n")
      : "nenhuma causa candidata encontrada";

  const skuLine =
    row.skus === null ? "sem SKU vinculado" : `${row.skus.sku}${row.skus.title === null ? "" : ` — ${row.skus.title}`}`;

  return [
    `Tipo de ação: ${view.kindLabel}${view.direcaoLabel === null ? "" : ` (${view.direcaoLabel})`}`,
    `SKU: ${skuLine}`,
    `Confiança calculada: ${row.confidence}`,
    `Impacto estimado: ${row.estimated_impact_brl === null ? "desconhecido" : currencyFormatter.format(row.estimated_impact_brl)}`,
    `Evidências:\n${evidencias}`,
    `Causas candidatas (eventos datados):\n${causas}`,
    `Recomendação do sistema: ${row.recommendation}`,
  ].join("\n\n");
}

/**
 * Diferente de `runNarrateSkuDiagnosis`, aqui não existe contrato vindo do
 * chamador: a ação já vive em `actions` e a leitura sob a RLS do usuário é
 * autorização e dado no mesmo ato. Ação de outra organização simplesmente
 * não é encontrada.
 */
export async function runNarrateAction(
  userClient: UserClient,
  input: NarrateActionInput,
  anthropic: AnthropicClient,
): Promise<{ data: NarrateActionOutput; costUsd: number }> {
  const action = await userClient
    .from("actions")
    .select("kind, confidence, estimated_impact_brl, evidence, recommendation, skus(sku, title)")
    .eq("id", input.actionId)
    .maybeSingle();

  if (action.error !== null || action.data === null) {
    throw new CopilotToolError("Ação não encontrada ou sem permissão.");
  }

  const { text, costUsd } = await anthropic.narrate({
    system: ACTION_EXPLANATION_SYSTEM_PROMPT,
    prompt: buildActionExplanationPrompt(action.data),
    // Cinco seções rotuladas de 1-2 frases passam com folga de 512 só na
    // maioria das vezes — truncar a última seção no meio é falha certa.
    maxTokens: 768,
  });

  return { data: { narrativa: text }, costUsd };
}

interface ToolOutcome {
  data: unknown;
  llmUsed: boolean;
  costUsd: number | null;
}

interface ToolDefinition {
  inputSchema: ZodType;
  run: (userClient: UserClient, input: never, deps: CopilotDeps) => Promise<ToolOutcome>;
}

const TOOLS: Record<CopilotToolName, ToolDefinition> = {
  sales_summary: {
    inputSchema: salesSummaryInputSchema,
    run: async (userClient, input) => ({ data: await runSalesSummary(userClient, input), llmUsed: false, costUsd: null }),
  },
  sales_period_comparison: {
    inputSchema: salesPeriodComparisonInputSchema,
    run: async (userClient, input) => ({
      data: await runSalesPeriodComparison(userClient, input),
      llmUsed: false,
      costUsd: null,
    }),
  },
  sales_account_comparison: {
    inputSchema: salesAccountComparisonInputSchema,
    run: async (userClient, input) => ({
      data: await runSalesAccountComparison(userClient, input),
      llmUsed: false,
      costUsd: null,
    }),
  },
  narrate_sku_diagnosis: {
    inputSchema: narrateSkuDiagnosisInputSchema,
    run: async (userClient, input, deps) => {
      const outcome = await runNarrateSkuDiagnosis(userClient, input, deps.anthropic);

      return { data: outcome.data, llmUsed: true, costUsd: outcome.costUsd };
    },
  },
  narrate_action: {
    inputSchema: narrateActionInputSchema,
    run: async (userClient, input, deps) => {
      const outcome = await runNarrateAction(userClient, input, deps.anthropic);

      return { data: outcome.data, llmUsed: true, costUsd: outcome.costUsd };
    },
  },
  suggest_support_reply: {
    inputSchema: suggestSupportReplyInputSchema,
    run: async (userClient, input, deps) => {
      const outcome = await runSuggestSupportReply(userClient, input, deps.anthropic);

      return { data: outcome.data, llmUsed: true, costUsd: outcome.costUsd };
    },
  },
  structure_feature_suggestion: {
    inputSchema: structureFeatureSuggestionInputSchema,
    run: async (userClient, input, deps) => {
      const outcome = await runStructureFeatureSuggestion(userClient, input, deps.anthropic);

      return { data: outcome.data, llmUsed: true, costUsd: outcome.costUsd };
    },
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

  let outcome: ToolOutcome;

  try {
    outcome = await definition.run(userClient, parsedInput.data as never, deps);
  } catch (error) {
    const message = error instanceof CopilotToolError ? error.message : "falha ao executar a ferramenta";

    deps.logger.error("copilot_tool_failed", { tool: request.tool, error });

    return { status: 502, body: { error: { code: "tool_failed", message } } };
  }

  const { data, llmUsed, costUsd } = outcome;
  const latencyMs = Date.now() - startedAt;

  const recorded = await recordAiRun(deps.db, {
    organization_id: caller.organizationId,
    user_id: caller.userId,
    tool_names: [request.tool],
    scope: parsedInput.data as Record<string, unknown>,
    llm_used: llmUsed,
    cost_usd: costUsd,
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
