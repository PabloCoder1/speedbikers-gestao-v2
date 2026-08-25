import { z } from "zod";

/**
 * Ferramentas do Copiloto (`docs/COPILOT.md` secao 4): schema Zod de
 * entrada e saída de cada uma, validado nas duas pontas (`api` e, quando
 * existir, a UI que monta o pedido). Nenhuma SQL é gerada por LLM — cada
 * ferramenta daqui é o único jeito de o Copiloto tocar o banco.
 *
 * Primeira leva (`docs/COPILOT.md` secao 10, "as primeiras ferramentas
 * acompanham a tela âncora, o Dashboard de vendas Geral e por Conta"):
 * vendas por período, comparação entre períodos e comparação entre contas
 * — as três já existem como consulta na tela `/vendas`
 * (`get_sales_summary`), só ganham contrato tipado e ficam alcançáveis
 * pela `api` além do `web`.
 */

const dateSchema = z.iso.date();

export const salesSummarySchema = z.object({
  unitsSold: z.number().int(),
  grossRevenue: z.number(),
  ordersCount: z.number().int(),
  purchasesCount: z.number().int(),
  averageTicket: z.number().nullable(),
  averageSellingPrice: z.number().nullable(),
  /** Nulo = período nunca calculado (backfill/reconciliação ainda não tocou) — nunca finge zero. */
  lastComputedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type SalesSummary = z.infer<typeof salesSummarySchema>;

/** Consulta pontual (`docs/COPILOT.md` secao 4, categoria "Série temporal"): vendas de um período, geral ou por conta. */
export const salesSummaryInputSchema = z.object({
  dateFrom: dateSchema,
  dateTo: dateSchema,
  /** Ausente = grão organização (RLS já limita às contas que o usuário alcança) — mesma semântica de `get_sales_summary`. */
  mlAccountId: z.uuid().optional(),
});
export type SalesSummaryInput = z.infer<typeof salesSummaryInputSchema>;

export const salesSummaryOutputSchema = salesSummarySchema;
export type SalesSummaryOutput = SalesSummary;

/** Comparação (`docs/COPILOT.md` secao 4): mesmo período pedido contra o período anterior de igual tamanho. */
export const salesPeriodComparisonInputSchema = salesSummaryInputSchema;
export type SalesPeriodComparisonInput = SalesSummaryInput;

export const salesPeriodComparisonOutputSchema = z.object({
  current: salesSummarySchema,
  previous: salesSummarySchema,
  previousRange: z.object({ dateFrom: dateSchema, dateTo: dateSchema }),
});
export type SalesPeriodComparisonOutput = z.infer<typeof salesPeriodComparisonOutputSchema>;

/** Comparação entre contas — mesmo período, 2 a 10 contas lado a lado. */
export const salesAccountComparisonInputSchema = z.object({
  dateFrom: dateSchema,
  dateTo: dateSchema,
  mlAccountIds: z.array(z.uuid()).min(2).max(10),
});
export type SalesAccountComparisonInput = z.infer<typeof salesAccountComparisonInputSchema>;

export const salesAccountComparisonOutputSchema = z.object({
  accounts: z.array(z.object({ mlAccountId: z.uuid(), summary: salesSummarySchema })),
});
export type SalesAccountComparisonOutput = z.infer<typeof salesAccountComparisonOutputSchema>;

/**
 * Diagnóstico (`docs/COPILOT.md` secao 4, categoria "Diagnóstico"; D-082):
 * narra em texto o contrato de `diagnoseSalesAnomaly` (`@sb/domain`,
 * D-063/D-078) já calculado pelo chamador. O LLM NUNCA produz o
 * diagnóstico — só recebe o contrato pronto e explica em português,
 * citando só o que está aqui dentro (`docs/COPILOT.md` secao 5, "nunca
 * inventar dado ausente"). Espelha `SalesAnomalyDiagnosis` de
 * `@sb/domain/diagnostics` campo a campo — nenhuma fórmula nova, só o
 * contrato de rede da mesma estrutura.
 */
export const diagnosisEvidenceSchema = z.object({
  tipo: z.string(),
  descricao: z.string(),
});

export const diagnosisCandidateCauseSchema = z.object({
  eventType: z.string(),
  occurredAt: z.iso.datetime({ offset: true }),
  descricao: z.string(),
});

export const salesAnomalyDiagnosisSchema = z.object({
  escopo: z.object({ organizationId: z.uuid(), skuId: z.uuid() }),
  periodo: z.object({ asOf: dateSchema }),
  direcao: z.enum(["queda", "alta"]),
  confianca: z.enum(["media", "alta"]),
  zScore: z.number(),
  unitsDelta: z.number(),
  evidencias: z.array(diagnosisEvidenceSchema),
  causasCandidatas: z.array(diagnosisCandidateCauseSchema),
  proximosPassos: z.array(z.string()),
});
export type SalesAnomalyDiagnosisPayload = z.infer<typeof salesAnomalyDiagnosisSchema>;

export const narrateSkuDiagnosisInputSchema = z.object({
  diagnosis: salesAnomalyDiagnosisSchema,
  impactBrl: z.number().nullable(),
});
export type NarrateSkuDiagnosisInput = z.infer<typeof narrateSkuDiagnosisInputSchema>;

export const narrateSkuDiagnosisOutputSchema = z.object({
  narrativa: z.string(),
});
export type NarrateSkuDiagnosisOutput = z.infer<typeof narrateSkuDiagnosisOutputSchema>;

/** Nome estável de cada ferramenta — é o que `ai_runs.tool_names` grava e o corpo de `POST /v1/copilot/query` referencia. */
export const COPILOT_TOOL_NAMES = [
  "sales_summary",
  "sales_period_comparison",
  "sales_account_comparison",
  "narrate_sku_diagnosis",
] as const;
export type CopilotToolName = (typeof COPILOT_TOOL_NAMES)[number];

export const copilotQueryRequestSchema = z.object({
  tool: z.enum(COPILOT_TOOL_NAMES),
  input: z.unknown(),
});
export type CopilotQueryRequest = z.infer<typeof copilotQueryRequestSchema>;
