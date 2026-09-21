import { recordAiRun } from "@sb/db";
import { toSalesMetricDate } from "@sb/domain";
import {
  listingPerformanceInputSchema,
  resolveCatalogEntityInputSchema,
  salesAccountComparisonInputSchema,
  salesPeriodComparisonInputSchema,
  salesSkuDeclinesInputSchema,
  salesSummaryInputSchema,
  skuReplenishmentInputSchema,
} from "@sb/contracts";
import { z } from "zod";

import type { PlanBlock, PlanMessage, PlanToolDefinition } from "./anthropic-client.js";
import type { Caller } from "./auth.js";
import type { CopilotDeps } from "./copilot.js";
import {
  runListingPerformance,
  runResolveCatalogEntity,
  runSalesAccountComparison,
  runSalesPeriodComparison,
  runSalesSummary,
  runSalesSkuDeclines,
  runSkuReplenishment,
} from "./copilot.js";

/**
 * Planner por linguagem natural (Fase 7, D-114) — o chat do Copiloto.
 *
 * A pergunta em português vira ESCOLHA de ferramenta via tool use; a
 * execução é 100% as ferramentas determinísticas já existentes (D-077),
 * sob a RLS do usuário. **Nenhuma SQL é gerada por LLM** — o modelo só
 * escolhe qual ferramenta e com quais argumentos, e os argumentos passam
 * pelo MESMO schema Zod que `POST /v1/copilot/query` valida: um argumento
 * inventado é recusado e vira `tool_result` de erro para o modelo
 * corrigir, nunca uma consulta malformada no banco.
 *
 * Streaming de verdade: o texto do modelo é repassado delta a delta ao
 * emissor SSE — inclusive o preâmbulo antes de uma consulta ("vou
 * verificar as vendas…"), que é exatamente o feedback que um chat precisa.
 */

/**
 * O CONTEXTO DE TELA (D-293) — a pré-condição que D-276 escreveu.
 *
 * A gaveta do Figma promete "o Copiloto lerá os dados desta tela", e a rota
 * recebia `{ message }` e mais nada. Aqui ele entra como um par fechado
 * `{ kind, id }`, e três coisas o mantêm honesto:
 *
 *  1. **`kind` é conjunto fechado** — só os contextos que existem como
 *     ferramenta. Um `kind` novo no payload é recusado, não ignorado;
 *  2. **o id NÃO é autoridade**: ele entra no prompt como "o usuário está
 *     olhando X", e quem lê o dado é a ferramenta, sob a RLS do chamador. Um
 *     id de outra organização não vira vazamento — vira ferramenta que não
 *     acha nada;
 *  3. **contexto não é ordem**: o modelo continua livre para responder outra
 *     coisa se a pergunta for outra. Amarrar a resposta à tela transformaria
 *     "quanto vendi ontem?" numa consulta sobre o SKU aberto.
 */
export const copilotContextSchema = z.object({
  kind: z.enum(["sku", "listing"]),
  /** O código do SKU ou o MLB do anúncio — o mesmo identificador que a tela mostra. */
  id: z.string().min(1).max(80),
  /** Só para anúncio: a conta dona dele, que a ferramenta exige. */
  mlAccountId: z.uuid().optional(),
});
export type CopilotContext = z.infer<typeof copilotContextSchema>;

export const copilotChatRequestSchema = z.object({
  message: z.string().min(1).max(1_000),
  context: copilotContextSchema.optional(),
});
export type CopilotChatRequest = z.infer<typeof copilotChatRequestSchema>;

/** Eventos que a rota SSE encaminha ao navegador. */
export type CopilotChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | { type: "done"; toolsUsed: string[] }
  | { type: "error"; message: string };

/** Rodadas de tool use no máximo: pergunta razoável usa 1-2; 4 é loop. */
const MAX_ROUNDS = 4;
const MAX_TOKENS = 1_024;

const DATE_PROPERTY = { type: "string", description: "Data YYYY-MM-DD" };

/**
 * Quando a pergunta pede explicitamente os produtos/SKUs que caíram, escolher
 * o consolidado é objetivamente errado. A data e a conta continuam sendo
 * extraídas pelo planner, mas a ferramenta deixa de ser uma aposta do modelo.
 */
function identifierInMessage(message: string): string | undefined {
  const mlb = /\bMLB\d+\b/i.exec(message)?.[0];
  if (mlb !== undefined) return mlb.toUpperCase();

  const explicitSku = /\bsku\s*(?:#|:)?\s*([A-Za-z0-9][A-Za-z0-9._/-]{0,79})\b/i.exec(message)?.[1];
  if (explicitSku !== undefined) return explicitSku;

  // Códigos numéricos longos (como 13014) e alfanuméricos são candidatos;
  // datas curtas, valores e palavras comuns não entram aqui.
  return /\b(?:\d{4,}|[A-Za-z]+[A-Za-z0-9._/-]*\d[A-Za-z0-9._/-]*)\b/.exec(message)?.[0];
}

function forcedToolForMessage(message: string): "resolve_catalog_entity" | "sales_sku_declines" | undefined {
  if (identifierInMessage(message) !== undefined) return "resolve_catalog_entity";

  const normalized = message.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const asksForProduct = /\b(produto|produtos|sku|skus|item|itens)\b/.test(normalized);
  const asksForDecline = /\b(queda|quedas|caiu|ca[ií]ram|vendeu menos|venderam menos|perdeu receita)\b/.test(normalized);

  return asksForProduct && asksForDecline ? "sales_sku_declines" : undefined;
}

/**
 * As MESMAS três ferramentas determinísticas de D-077, traduzidas para o
 * formato de tool use. A narração de diagnóstico e as gerações de D-112
 * ficam FORA do chat de propósito: são contextuais (têm botão onde o dado
 * mora) e receber `supportCaseId`/contrato de diagnóstico por chat não faz
 * sentido de uso.
 */
const CHAT_TOOLS: PlanToolDefinition[] = [
  {
    name: "sales_summary",
    description:
      "Resumo de vendas de um período: unidades, receita bruta, pedidos, ticket médio. Sem mlAccountId = todas as contas somadas.",
    input_schema: {
      type: "object",
      properties: {
        dateFrom: DATE_PROPERTY,
        dateTo: DATE_PROPERTY,
        mlAccountId: { type: "string", description: "UUID da conta (da lista do contexto); omita para o consolidado" },
      },
      required: ["dateFrom", "dateTo"],
    },
  },
  {
    name: "sales_period_comparison",
    description: "Compara o período pedido com o período anterior de igual tamanho.",
    input_schema: {
      type: "object",
      properties: {
        dateFrom: DATE_PROPERTY,
        dateTo: DATE_PROPERTY,
        mlAccountId: { type: "string", description: "UUID da conta; omita para o consolidado" },
      },
      required: ["dateFrom", "dateTo"],
    },
  },
  {
    name: "sales_account_comparison",
    description: "Compara as vendas de 2 a 10 contas no mesmo período, lado a lado.",
    input_schema: {
      type: "object",
      properties: {
        dateFrom: DATE_PROPERTY,
        dateTo: DATE_PROPERTY,
        mlAccountIds: { type: "array", items: { type: "string" }, description: "UUIDs das contas (da lista do contexto)" },
      },
      required: ["dateFrom", "dateTo", "mlAccountIds"],
    },
  },
  {
    name: "sales_sku_declines",
    description:
      "Lista os produtos com MAIOR QUEDA entre o período pedido e o período anterior de igual tamanho. Retorna SKU, título, unidades, receita e variação dos dois períodos. Use para 'qual produto caiu?', 'quais itens venderam menos?' ou 'onde perdemos receita'. Não use para atribuir a causa de uma queda.",
    input_schema: {
      type: "object",
      properties: {
        dateFrom: DATE_PROPERTY,
        dateTo: DATE_PROPERTY,
        mlAccountId: { type: "string", description: "UUID da conta; omita para o consolidado" },
        orderBy: { type: "string", enum: ["units", "revenue"], description: "Ordenar por queda de unidades (padrão) ou receita" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Quantidade de produtos; padrão 10" },
      },
      required: ["dateFrom", "dateTo"],
    },
  },
  {
    name: "resolve_catalog_entity",
    description:
      "Resolve um código digitado como SKU ou anúncio Mercado Livre antes de consultar dados. Use primeiro quando a pergunta trouxer um identificador (ex.: 13014, SB-001 ou MLB123). LISTING traz mlAccountId; AMBIGUO exige declarar a ambiguidade ou usar a conta explicitada. MLB é sempre anúncio, nunca SKU.",
    input_schema: {
      type: "object",
      properties: { identifier: { type: "string", description: "Código exato digitado pelo usuário" } },
      required: ["identifier"],
    },
  },
  /*
    AS DUAS FERRAMENTAS ALÉM DE VENDA (D-293). A descrição de cada uma diz o
    que ela NÃO responde — é o que impede o modelo de escolher a ferramenta
    errada e narrar em cima de um número que não é daquilo.
  */
  {
    name: "sku_replenishment",
    description:
      "Estoque e reposição de UM SKU pelo código: aproveitável (local + Full + trânsito), venda de 15/30/60/90 dias, tendência, cobertura em dias, estado operacional e quantidade sugerida de compra. Não responde quanto enviar ao Full (não há política logística) nem movimentações individuais.",
    input_schema: {
      type: "object",
      properties: {
        sku: { type: "string", description: "O código do SKU, como aparece na tela (ex.: SB-001)" },
      },
      required: ["sku"],
    },
  },
  {
    name: "listing_performance",
    description:
      "Desempenho de UM anúncio no período: visitas, unidades vendidas, pedidos, receita e conversão, mais preço e situação do cadastro. `visitsCoverage` informa se visitas têm cobertura completa, parcial ou nenhuma: SEM_COBERTURA significa que visitas são desconhecidas, não zero. Conversão NULA significa que não há denominador observado. Não atribua pausa/inatividade sem usar o status retornado.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "O MLB do anúncio" },
        mlAccountId: { type: "string", description: "UUID da conta dona do anúncio (da lista do contexto)" },
        dateFrom: DATE_PROPERTY,
        dateTo: DATE_PROPERTY,
      },
      required: ["itemId", "mlAccountId", "dateFrom", "dateTo"],
    },
  },
];

interface ChatToolRunner {
  schema: z.ZodType;
  /*
    `organizationId` entrou em D-293 junto das ferramentas de estoque e
    anúncio: as RPCs delas exigem `p_organization_id`. O id vem da
    autenticação, nunca do payload — e a RLS continua sendo a autorização.
  */
  run: (
    userClient: ReturnType<CopilotDeps["createUserClient"]>,
    input: never,
    organizationId: string,
  ) => Promise<unknown>;
}

const RUNNERS: Record<string, ChatToolRunner> = {
  sales_summary: { schema: salesSummaryInputSchema, run: runSalesSummary },
  sales_period_comparison: { schema: salesPeriodComparisonInputSchema, run: runSalesPeriodComparison },
  sales_account_comparison: { schema: salesAccountComparisonInputSchema, run: runSalesAccountComparison },
  sales_sku_declines: { schema: salesSkuDeclinesInputSchema, run: runSalesSkuDeclines },
  resolve_catalog_entity: { schema: resolveCatalogEntityInputSchema, run: runResolveCatalogEntity },
  sku_replenishment: { schema: skuReplenishmentInputSchema, run: runSkuReplenishment },
  listing_performance: { schema: listingPerformanceInputSchema, run: runListingPerformance },
};

/**
 * A frase de contexto (D-293). Ela diz ao modelo O QUE o usuário está olhando
 * e nada mais: o dado continua vindo da ferramenta, sob a RLS de quem
 * perguntou. É deliberado que não seja uma ordem — "responda sobre este SKU"
 * transformaria "quanto vendi ontem?" numa consulta sobre o SKU aberto.
 */
function describeContext(context: CopilotContext | undefined): string[] {
  if (context === undefined) {
    return [];
  }

  const alvo =
    context.kind === "sku"
      ? `o SKU ${context.id}`
      : `o anúncio ${context.id}${context.mlAccountId === undefined ? "" : ` (conta ${context.mlAccountId})`}`;

  return [
    `Contexto: o usuário está com ${alvo} aberto na tela.`,
    "- Se a pergunta for sobre 'este SKU', 'este anúncio' ou 'aqui', use o contexto acima para preencher os argumentos da ferramenta.",
    "- Se a pergunta for sobre outra coisa, IGNORE o contexto — ele diz onde a pessoa está, não sobre o que ela pode perguntar.",
  ];
}

function buildSystemPrompt(
  today: string,
  accounts: { id: string; label: string }[],
  context: CopilotContext | undefined,
): string {
  const accountList =
    accounts.length > 0
      ? accounts.map((account) => `- ${account.label}: ${account.id}`).join("\n")
      : "(nenhuma conta acessível)";

  return [
    "Você é o Copiloto da Speed Bikers Gestão, um assistente de dados da operação no Mercado Livre.",
    `Hoje é ${today} (fuso America/Sao_Paulo). Use esta data para calcular períodos como "últimos 7 dias".`,
    "Contas Mercado Livre que este usuário pode consultar (rótulo: UUID):",
    accountList,
    ...describeContext(context),
    "Regras estritas:",
    "- Responda SOMENTE com base nos resultados das ferramentas. Nunca invente número, conta ou período.",
    "- Sempre diga qual período e qual conta (ou consolidado) a resposta cobre.",
    "- Valores monetários em reais (R$). Seja conciso.",
    "- Para 'qual produto caiu' ou 'quais venderam menos', use sales_sku_declines. Ele só devolve quedas reais contra o período anterior equivalente; informe os dois períodos e não atribua causa sem evidência específica.",
    "- Quando a pergunta trouxer um código (por exemplo 13014, SB-001 ou MLB123), use resolve_catalog_entity ANTES de outra ferramenta. SKU usa sku_replenishment; LISTING usa listing_performance com o mlAccountId retornado. AMBIGUO não é licença para adivinhar: mostre a ambiguidade ou use somente a conta que o usuário explicitou. MLB é sempre anúncio.",
    "- Em listing_performance, SEM_COBERTURA significa que a coleta de visitas não cobriu a janela: diga que visitas são desconhecidas, nunca '0 visitas' ou 'falta de tráfego'. PARCIAL exige declarar quantos dias foram observados. Só trate visitas como zero sob cobertura observada.",
    "- Não sugira que um anúncio está pausado, inativo ou sem visibilidade sem o status retornado pela ferramenta; hipótese não é fato.",
    "- Se a pergunta não puder ser respondida pelas ferramentas disponíveis (vendas por período, comparação de períodos, quedas por produto, comparação entre contas, estoque e reposição de um SKU, desempenho de um anúncio), diga isso e aponte o que você consegue responder — nunca improvise.",
    "- Número ausente NÃO é zero: cobertura, estado e sugestão vêm nulos sob recusa (sem configuração de reposição, saldo sentinela, histórico incompleto), e conversão vem nula quando não houve visita. Diga a recusa em vez de preencher a lacuna.",
    "- Perguntas sobre um dia ainda em andamento podem estar incompletas — as métricas fecham por dia.",
  ].join("\n");
}

/**
 * Roda o chat de ponta a ponta, emitindo eventos. Devolve o custo somado de
 * todas as rodadas — o chamador grava `ai_runs`. Nunca lança: erro vira
 * evento `error`, porque numa resposta SSE já iniciada não existe mais
 * status HTTP para falhar.
 */
export async function runCopilotChat(
  deps: CopilotDeps,
  caller: Caller,
  accessToken: string,
  request: CopilotChatRequest,
  emit: (event: CopilotChatEvent) => Promise<void>,
): Promise<void> {
  const userClient = deps.createUserClient(accessToken);
  const startedAt = Date.now();
  const toolsUsed: string[] = [];
  let costUsd = 0;

  try {
    const accountsResult = await userClient.from("ml_accounts").select("id, label").order("label");
    const accounts = accountsResult.error === null ? accountsResult.data : [];

    const system = buildSystemPrompt(toSalesMetricDate(new Date()), accounts, request.context);
    const messages: PlanMessage[] = [{ role: "user", content: request.message }];
    const forcedTool = forcedToolForMessage(request.message);

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const result = await deps.anthropic.plan({
        system,
        messages,
        tools: CHAT_TOOLS,
        ...(round === 0 && forcedTool !== undefined ? { toolChoice: forcedTool } : {}),
        maxTokens: MAX_TOKENS,
        onText: (delta) => {
          void emit({ type: "text", delta });
        },
      });

      costUsd += result.costUsd;

      if (result.stopReason !== "tool_use") {
        break;
      }

      const toolUses = result.blocks.filter(
        (block): block is Extract<PlanBlock, { type: "tool_use" }> => block.type === "tool_use",
      );

      messages.push({ role: "assistant", content: result.blocks });

      const toolResults: unknown[] = [];

      for (const toolUse of toolUses) {
        toolsUsed.push(toolUse.name);
        await emit({ type: "tool", name: toolUse.name });

        const runner = RUNNERS[toolUse.name];

        if (runner === undefined) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: "ferramenta desconhecida",
            is_error: true,
          });

          continue;
        }

        // O MESMO schema de /v1/copilot/query: argumento inventado pelo
        // modelo é recusado aqui, nunca vira consulta.
        const parsed = runner.schema.safeParse(toolUse.input);

        if (!parsed.success) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `argumentos inválidos: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
            is_error: true,
          });

          continue;
        }

        try {
          const data = await runner.run(userClient, parsed.data as never, caller.organizationId);

          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(data) });
        } catch (error) {
          // O erro volta para o MODELO decidir como explicar — nunca some.
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: error instanceof Error ? error.message : "falha ao executar a ferramenta",
            is_error: true,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });

      if (round === MAX_ROUNDS - 1) {
        await emit({
          type: "error",
          message: "A conversa passou do limite de consultas por pergunta — tente uma pergunta mais direta.",
        });
      }
    }

    await emit({ type: "done", toolsUsed });
  } catch (error) {
    deps.logger.error("copilot_chat_failed", { error });
    await emit({ type: "error", message: "Falha ao consultar o Copiloto. Tente de novo." });
  }

  // Best-effort, como em handleCopilotQuery: observabilidade nunca dita o
  // resultado da operação que observa.
  const recorded = await recordAiRun(deps.db, {
    organization_id: caller.organizationId,
    user_id: caller.userId,
    tool_names: ["copilot_chat", ...new Set(toolsUsed)],
    scope: { message_length: request.message.length, context_kind: request.context?.kind ?? null },
    llm_used: true,
    cost_usd: costUsd,
    latency_ms: Date.now() - startedAt,
  });

  if (!recorded.ok) {
    deps.logger.warn("ai_run_record_failed", { tool: "copilot_chat", reason: recorded.reason });
  }
}
