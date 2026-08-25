import type { AdminClient } from "./admin-client.js";

/**
 * Gravação do histórico de uso/custo do Copiloto (`docs/COPILOT.md` secao
 * 3). Mesmo padrão de `recordJobRun`: **nunca lança**. A ferramenta já
 * calculou a resposta — uma falha ao registrar o `ai_runs` não pode fazer
 * a `api` devolver erro para uma consulta que funcionou; observabilidade
 * não pode ditar o resultado da operação que ela observa.
 *
 * Tipo escrito à mão, não `TablesInsert<"ai_runs">`: a migration
 * `20260825120000_create_ai_runs.sql` ainda não aplicou no Supabase Dev
 * quando este arquivo foi escrito, então `types.ts` ainda não conhece a
 * tabela — mesma situação (e mesma solução temporária) já documentada em
 * D-073. Trocar para o tipo gerado assim que `packages/db/src/types.ts`
 * for regenerado.
 */
export interface AiRunInsert {
  organization_id: string;
  user_id: string;
  tool_names: string[];
  scope: Record<string, unknown>;
  llm_used?: boolean;
  cost_usd?: number | null;
  latency_ms: number;
}

export type RecordResult = { ok: true } | { ok: false; reason: string };

export async function recordAiRun(client: AdminClient, run: AiRunInsert): Promise<RecordResult> {
  // `as never`: `ai_runs` ainda não existe em `Database` (types.ts não
  // regenerado, ver comentário de `AiRunInsert` acima). Remover o cast
  // junto com a troca de `AiRunInsert` para `TablesInsert<"ai_runs">`.
  const { error } = await client.from("ai_runs" as never).insert(run as never);

  if (error !== null) {
    return { ok: false, reason: error.message };
  }

  return { ok: true };
}
