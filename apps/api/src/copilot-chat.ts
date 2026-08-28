import { recordAiRun } from "@sb/db";
import { toSalesMetricDate } from "@sb/domain";
import {
  salesAccountComparisonInputSchema,
  salesPeriodComparisonInputSchema,
  salesSummaryInputSchema,
} from "@sb/contracts";
import { z } from "zod";

import type { PlanBlock, PlanMessage, PlanToolDefinition } from "./anthropic-client.js";
import type { Caller } from "./auth.js";
import type { CopilotDeps } from "./copilot.js";
import { runSalesAccountComparison, runSalesPeriodComparison, runSalesSummary } from "./copilot.js";

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

export const copilotChatRequestSchema = z.object({
  message: z.string().min(1).max(1_000),
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
];

interface ChatToolRunner {
  schema: z.ZodType;
  run: (userClient: ReturnType<CopilotDeps["createUserClient"]>, input: never) => Promise<unknown>;
}

const RUNNERS: Record<string, ChatToolRunner> = {
  sales_summary: { schema: salesSummaryInputSchema, run: runSalesSummary },
  sales_period_comparison: { schema: salesPeriodComparisonInputSchema, run: runSalesPeriodComparison },
  sales_account_comparison: { schema: salesAccountComparisonInputSchema, run: runSalesAccountComparison },
};

function buildSystemPrompt(today: string, accounts: { id: string; label: string }[]): string {
  const accountList =
    accounts.length > 0
      ? accounts.map((account) => `- ${account.label}: ${account.id}`).join("\n")
      : "(nenhuma conta acessível)";

  return [
    "Você é o Copiloto da Speed Bikers Gestão, um assistente de dados de vendas do Mercado Livre.",
    `Hoje é ${today} (fuso America/Sao_Paulo). Use esta data para calcular períodos como "últimos 7 dias".`,
    "Contas Mercado Livre que este usuário pode consultar (rótulo: UUID):",
    accountList,
    "Regras estritas:",
    "- Responda SOMENTE com base nos resultados das ferramentas. Nunca invente número, conta ou período.",
    "- Sempre diga qual período e qual conta (ou consolidado) a resposta cobre.",
    "- Valores monetários em reais (R$). Seja conciso.",
    "- Se a pergunta não puder ser respondida pelas ferramentas disponíveis (vendas por período, comparação de períodos, comparação entre contas), diga isso e aponte o que você consegue responder — nunca improvise.",
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

    const system = buildSystemPrompt(toSalesMetricDate(new Date()), accounts);
    const messages: PlanMessage[] = [{ role: "user", content: request.message }];

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const result = await deps.anthropic.plan({
        system,
        messages,
        tools: CHAT_TOOLS,
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
          const data = await runner.run(userClient, parsed.data as never);

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
    scope: { message_length: request.message.length },
    llm_used: true,
    cost_usd: costUsd,
    latency_ms: Date.now() - startedAt,
  });

  if (!recorded.ok) {
    deps.logger.warn("ai_run_record_failed", { tool: "copilot_chat", reason: recorded.reason });
  }
}
