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

/**
 * Explicação de AÇÃO da Central de Ações (`docs/COPILOT.md` secao 4, D-155 —
 * o último item da Fase 6B): narra em texto uma ação já detectada pelo
 * pipeline determinístico (D-064/D-116). Diferente de `narrate_sku_diagnosis`
 * — cujo contrato é calculado na hora pelo `web` e viaja no corpo —, a ação
 * JÁ VIVE no banco (`actions`): o input é só o id, e a `api` lê a linha sob a
 * RLS do próprio usuário (autorização e dado no mesmo ato — não existe
 * contrato forjável). A narração segue o vocabulário obrigatório do PRD:
 * causa mais provável, fatores contribuintes, hipóteses, evidências
 * contrárias e o que não conseguimos verificar — nunca "causa verdadeira".
 */
export const narrateActionInputSchema = z.object({
  actionId: z.uuid(),
});
export type NarrateActionInput = z.infer<typeof narrateActionInputSchema>;

export const narrateActionOutputSchema = z.object({
  narrativa: z.string(),
});
export type NarrateActionOutput = z.infer<typeof narrateActionOutputSchema>;

/**
 * Sugestão de resposta de atendimento (`docs/COPILOT.md` secao 11, D-071/D-112):
 * gera o TEXTO de uma resposta a partir do contexto determinístico do case
 * (transcript, vínculos, produto). Mesma família de "Estruturação" — geração
 * de texto revisável, NUNCA ferramenta de escrita: quem envia é o comando
 * privilegiado de D-096, depois de confirmação humana.
 */
export const suggestSupportReplyInputSchema = z.object({
  supportCaseId: z.uuid(),
});
export type SuggestSupportReplyInput = z.infer<typeof suggestSupportReplyInputSchema>;

export const suggestSupportReplyOutputSchema = z.object({
  suggestedText: z.string(),
});
export type SuggestSupportReplyOutput = z.infer<typeof suggestSupportReplyOutputSchema>;

/**
 * Estruturação de sugestão de feature (`docs/COPILOT.md` secao 4, categoria
 * "Estruturação"; requisito da Fase 7, D-079/D-112): preenche os nove campos
 * estruturados de `feature_suggestions` a partir do texto original — que é
 * PRESERVADO intacto, por requisito. Campo não inferível fica nulo, nunca
 * inventado.
 */
export const structureFeatureSuggestionInputSchema = z.object({
  suggestionId: z.uuid(),
});
export type StructureFeatureSuggestionInput = z.infer<typeof structureFeatureSuggestionInputSchema>;

export const structuredSuggestionFieldsSchema = z.object({
  title: z.string().nullable(),
  problem: z.string().nullable(),
  objective: z.string().nullable(),
  impactedUsers: z.string().nullable(),
  suggestedFlow: z.string().nullable(),
  expectedBenefit: z.string().nullable(),
  acceptanceCriteria: z.string().nullable(),
  dependenciesRisks: z.string().nullable(),
  complexity: z.string().nullable(),
});
export type StructuredSuggestionFields = z.infer<typeof structuredSuggestionFieldsSchema>;

export const structureFeatureSuggestionOutputSchema = structuredSuggestionFieldsSchema;
export type StructureFeatureSuggestionOutput = StructuredSuggestionFields;

/** Nome estável de cada ferramenta — é o que `ai_runs.tool_names` grava e o corpo de `POST /v1/copilot/query` referencia. */
export const COPILOT_TOOL_NAMES = [
  "sales_summary",
  "sales_period_comparison",
  "sales_account_comparison",
  // Segunda leva (D-293): as ferramentas alem de venda.
  "sku_replenishment",
  "listing_performance",
  "narrate_sku_diagnosis",
  "narrate_action",
  "suggest_support_reply",
  "structure_feature_suggestion",
] as const;
export type CopilotToolName = (typeof COPILOT_TOOL_NAMES)[number];

export const copilotQueryRequestSchema = z.object({
  tool: z.enum(COPILOT_TOOL_NAMES),
  input: z.unknown(),
});
export type CopilotQueryRequest = z.infer<typeof copilotQueryRequestSchema>;

/**
 * SEGUNDA LEVA (D-293) — as ferramentas ALÉM DE VENDA, que são a pré-condição
 * que D-276 escreveu para a gaveta do Copiloto.
 *
 * A medição de D-276: das doze perguntas sugeridas pelo desenho, **uma** tinha
 * como ser respondida, porque as três ferramentas eram todas de venda. Estas
 * duas atacam os dois contextos que o produto de fato sustenta hoje — o SKU e
 * o anúncio —, e cada uma nasce colada numa fonte que já é dona do número:
 *
 *  - `sku_replenishment` compõe `get_purchase_suggestions` com as peças de
 *    `@sb/domain` (`composeSkuReplenishment`), as MESMAS que `/reposicao`
 *    usa. O Copiloto e a tela respondem o mesmo, por construção;
 *  - `listing_performance` lê `get_listing_dashboard_summary`, dona de visitas
 *    e conversão por anúncio.
 *
 * **O que continua sem ferramenta, e por quê:** "quanto enviar ao Full" (não
 * há política logística — a mesma recusa de D-147), "histórico de exposição"
 * (o dado de tráfego não existe no esquema, D-266) e o contexto de pedido/
 * atendimento (rastreio e risco de mediação não têm fonte). Sugerir pergunta
 * que o sistema não responde é pior que campo vazio: a sugestão promete e
 * falha DEPOIS de gastar uma chamada paga.
 */
export const skuReplenishmentInputSchema = z.object({
  /** O CÓDIGO do SKU (o que aparece na tela), não o UUID: é o que o usuário digita e o que o modelo enxerga. */
  sku: z.string().min(1).max(80),
});
export type SkuReplenishmentInput = z.infer<typeof skuReplenishmentInputSchema>;

export const skuReplenishmentOutputSchema = z.object({
  sku: z.string(),
  title: z.string().nullable(),
  supplierBrand: z.string().nullable(),
  abcClass: z.string().nullable(),
  /** Aproveitável: local + Full + trânsito, reservado FORA. Nulo para saldo sentinela (D-127). */
  usableStock: z.number().nullable(),
  stockParts: z.object({
    local: z.number(),
    full: z.number(),
    transit: z.number(),
    reservedExcluded: z.number(),
  }),
  units: z.object({ d15: z.number(), d30: z.number(), d60: z.number(), d90: z.number() }),
  /** Tendência classificada (`ACELERANDO`, `ESTAVEL`, …) ou a recusa dela. */
  trend: z.string(),
  /** `aproveitável ÷ venda média diária de 30 dias`; nulo quando indefinida. */
  coverageDays: z.number().nullable(),
  /** Estado operacional (`RUPTURA`, `COMPRA_URGENTE`, …); nulo sob recusa. */
  state: z.string().nullable(),
  /** As recusas em vigor — é o que impede o modelo de tratar nulo como zero. */
  refusals: z.array(z.string()),
  suggestedQuantity: z.number().nullable(),
  policy: z
    .object({
      scope: z.string(),
      leadTimeDays: z.number(),
      targetCoverageDays: z.number(),
      safetyStockDays: z.number(),
      maxCoverageDays: z.number().nullable(),
    })
    .nullable(),
});
export type SkuReplenishmentOutput = z.infer<typeof skuReplenishmentOutputSchema>;

export const listingPerformanceInputSchema = z.object({
  /** O MLB do anúncio. */
  itemId: z.string().min(1).max(40),
  mlAccountId: z.uuid(),
  dateFrom: dateSchema,
  dateTo: dateSchema,
});
export type ListingPerformanceInput = z.infer<typeof listingPerformanceInputSchema>;

export const listingPerformanceOutputSchema = z.object({
  itemId: z.string(),
  title: z.string().nullable(),
  status: z.string().nullable(),
  price: z.number().nullable(),
  availableQuantity: z.number().nullable(),
  visits: z.number(),
  unitsSold: z.number(),
  ordersCount: z.number(),
  grossRevenue: z.number(),
  /** NULO sem visita no período — conversão sem denominador não é 0% (D-123). */
  conversion: z.number().nullable(),
  daysObserved: z.number(),
});
export type ListingPerformanceOutput = z.infer<typeof listingPerformanceOutputSchema>;
