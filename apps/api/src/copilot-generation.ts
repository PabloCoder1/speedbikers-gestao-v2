import type { UserClient } from "@sb/db";
import type {
  StructureFeatureSuggestionInput,
  StructureFeatureSuggestionOutput,
  SuggestSupportReplyInput,
  SuggestSupportReplyOutput,
} from "@sb/contracts";
import { structuredSuggestionFieldsSchema } from "@sb/contracts";

import type { AnthropicClient } from "./anthropic-client.js";
import { CopilotToolError } from "./copilot.js";

/**
 * As duas ferramentas de GERAÇÃO DE TEXTO do Copiloto (D-112) — mesma
 * família de `narrate_sku_diagnosis` (D-082): contexto determinístico
 * entra, texto revisável sai. Nenhuma delas escreve no Mercado Livre nem
 * executa ação — a regra de `docs/COPILOT.md` secao 6 ("sem ferramenta de
 * escrita") continua sem exceção.
 */

// ---------------------------------------------------------------------------
// suggest_support_reply (docs/COPILOT.md secao 11, Fase 7B)
// ---------------------------------------------------------------------------

const SUPPORT_REPLY_SYSTEM_PROMPT = [
  "Você redige uma RESPOSTA SUGERIDA para o atendimento de uma loja no Mercado Livre, que um atendente humano vai revisar, editar e só então enviar.",
  "Regras estritas:",
  "- Use SOMENTE as informações do contexto fornecido. Nunca invente estoque, prazo, preço, compatibilidade ou qualquer característica do produto que não esteja explícita no contexto.",
  "- Se a pergunta do cliente pedir uma informação que o contexto não traz (por exemplo, compatibilidade com um veículo), a resposta deve dizer com clareza que será confirmado — nunca afirme nem negue sem base.",
  "- Português do Brasil, tom cordial e direto, do ponto de vista da loja.",
  "- No máximo 900 caracteres. Sem saudação genérica repetida, sem placeholders como {nome}, sem assinatura.",
  "- Responda APENAS com o texto da resposta, nada antes ou depois.",
].join("\n");

const TRANSCRIPT_LIMIT = 40;

interface TranscriptRow {
  direction: string;
  sender_kind: string;
  body: string | null;
  body_state: string;
  occurred_at: string;
}

function formatTranscript(rows: TranscriptRow[]): string {
  if (rows.length === 0) {
    return "(sem mensagens registradas)";
  }

  return rows
    .map((row) => {
      const who = row.direction === "OUTBOUND" ? "Loja" : row.direction === "SYSTEM" ? "Mediador" : "Cliente";
      const body =
        row.body_state === "AVAILABLE" && row.body !== null ? row.body : `[mensagem ${row.body_state.toLowerCase()}]`;

      return `${who}: ${body}`;
    })
    .join("\n");
}

/**
 * Gera o texto sugerido para um case. Todo o contexto sai de consultas sob
 * a RLS do USUÁRIO — case fora do alcance é o mesmo 404 lógico da tela
 * (D-095), e os vínculos atravessam só `support_case_links`, nunca
 * coincidência de comprador (`docs/COPILOT.md` secao 11).
 */
export async function runSuggestSupportReply(
  userClient: UserClient,
  input: SuggestSupportReplyInput,
  anthropic: AnthropicClient,
): Promise<{ data: SuggestSupportReplyOutput; costUsd: number }> {
  const caseResult = await userClient
    .from("support_cases")
    .select(
      "id, channel, external_type, external_status, is_mediation, support_case_links(skus(sku, title), listings(title, item_id))",
    )
    .eq("id", input.supportCaseId)
    .maybeSingle();

  if (caseResult.error !== null || caseResult.data === null) {
    throw new CopilotToolError("Atendimento não encontrado ou sem permissão.");
  }

  const transcript = await userClient
    .from("support_messages")
    .select("direction, sender_kind, body, body_state, occurred_at")
    .eq("support_case_id", input.supportCaseId)
    .order("occurred_at", { ascending: true })
    .limit(TRANSCRIPT_LIMIT);

  if (transcript.error !== null) {
    throw new CopilotToolError("Não foi possível carregar a conversa do atendimento.");
  }

  const products = caseResult.data.support_case_links
    .map((link) => {
      const sku = link.skus;
      const listing = link.listings;

      if (sku !== null) return `SKU ${sku.sku}${sku.title === null ? "" : ` — ${sku.title}`}`;
      if (listing !== null) return `Anúncio ${listing.item_id} — ${listing.title}`;

      return null;
    })
    .filter((entry): entry is string => entry !== null);

  const channelLabel =
    caseResult.data.channel === "QUESTION"
      ? "pergunta pré-venda"
      : caseResult.data.channel === "CLAIM"
        ? `reclamação (${caseResult.data.external_type ?? "tipo desconhecido"})`
        : "conversa pós-venda";

  const prompt = [
    `Tipo de atendimento: ${channelLabel}${caseResult.data.is_mediation ? " EM MEDIAÇÃO com o Mercado Livre" : ""}`,
    `Produto(s) vinculado(s): ${products.length > 0 ? products.join("; ") : "nenhum vínculo registrado"}`,
    `Conversa até aqui:\n${formatTranscript(transcript.data)}`,
  ].join("\n\n");

  const { text, costUsd } = await anthropic.narrate({
    system: SUPPORT_REPLY_SYSTEM_PROMPT,
    prompt,
  });

  return { data: { suggestedText: text }, costUsd };
}

// ---------------------------------------------------------------------------
// structure_feature_suggestion (docs/COPILOT.md secao 4, Fase 7)
// ---------------------------------------------------------------------------

const STRUCTURE_SYSTEM_PROMPT = [
  "Você estrutura uma ideia de melhoria de sistema escrita em linguagem natural por um usuário interno.",
  "Devolva APENAS um objeto JSON válido, sem markdown, sem texto antes ou depois, com EXATAMENTE estas chaves:",
  '{"title","problem","objective","impactedUsers","suggestedFlow","expectedBenefit","acceptanceCriteria","dependenciesRisks","complexity"}',
  "Regras:",
  "- Cada valor é uma string curta em português do Brasil, fiel ao texto original — ou null quando o texto NÃO permite inferir aquele campo. Nunca invente.",
  "- title: até 80 caracteres. complexity: uma estimativa em uma palavra (baixa/média/alta) seguida de justificativa curta, ou null.",
].join("\n");

/** JSON pode vir cercado de ``` — extrai o primeiro objeto plausível. */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new CopilotToolError("O modelo não devolveu o formato esperado. Tente de novo.");
  }

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new CopilotToolError("O modelo não devolveu o formato esperado. Tente de novo.");
  }
}

/**
 * Estrutura uma sugestão e PERSISTE os nove campos sob a RLS do usuário —
 * a policy `feature_suggestions_update_admin` (D-079) é quem decide se o
 * chamador pode: ANALISTA recebe zero linha e um erro claro, sem RBAC
 * duplicado aqui. `original_text` nunca é tocado (requisito literal).
 */
export async function runStructureFeatureSuggestion(
  userClient: UserClient,
  input: StructureFeatureSuggestionInput,
  anthropic: AnthropicClient,
): Promise<{ data: StructureFeatureSuggestionOutput; costUsd: number }> {
  const suggestion = await userClient
    .from("feature_suggestions")
    .select("id, original_text")
    .eq("id", input.suggestionId)
    .maybeSingle();

  if (suggestion.error !== null || suggestion.data === null) {
    throw new CopilotToolError("Sugestão não encontrada ou sem permissão.");
  }

  const { text, costUsd } = await anthropic.narrate({
    system: STRUCTURE_SYSTEM_PROMPT,
    prompt: suggestion.data.original_text,
    // 9 campos em JSON não cabem nos 512 tokens da narração — JSON truncado
    // é falha certa de parse.
    maxTokens: 1_024,
  });

  const parsed = structuredSuggestionFieldsSchema.safeParse(extractJsonObject(text));

  if (!parsed.success) {
    throw new CopilotToolError("O modelo não devolveu o formato esperado. Tente de novo.");
  }

  const fields = parsed.data;

  const updated = await userClient
    .from("feature_suggestions")
    .update({
      title: fields.title,
      problem: fields.problem,
      objective: fields.objective,
      impacted_users: fields.impactedUsers,
      suggested_flow: fields.suggestedFlow,
      expected_benefit: fields.expectedBenefit,
      acceptance_criteria: fields.acceptanceCriteria,
      dependencies_risks: fields.dependenciesRisks,
      complexity: fields.complexity,
    })
    .eq("id", input.suggestionId)
    .select("id")
    .maybeSingle();

  if (updated.error !== null) {
    throw new CopilotToolError(updated.error.message);
  }

  if (updated.data === null) {
    // RLS filtrou: o papel do chamador não alcança UPDATE. O custo do LLM já
    // foi pago — fica registrado em ai_runs mesmo assim, como qualquer
    // chamada que não convergiu.
    throw new CopilotToolError("Só ADMIN e GESTOR estruturam sugestões.");
  }

  return { data: fields, costUsd };
}
