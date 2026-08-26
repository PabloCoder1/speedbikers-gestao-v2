"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "../../lib/supabase/server";

/**
 * Triagem do atendimento (Fase 7B, D-094) — Server Actions sobre a RPC
 * `triage_support_case`, NÃO escrita direta sob RLS.
 *
 * É a exceção deliberada ao padrão do resto do `web` (D-012, escrita simples
 * direto no banco): a triagem precisa atualizar `support_cases` E acrescentar
 * `support_case_events` na MESMA transação (D-084). Duas escritas separadas
 * do navegador não têm como ser atômicas, e um case que muda de status sem o
 * evento correspondente perde quem decidiu e quando — exatamente o que o
 * histórico append-only existe para impedir.
 *
 * A autorização real mora dentro da RPC (`security definer`, refaz acesso à
 * conta e papel). Nada aqui depende da interface ter escondido o botão.
 */

export interface TriageResult {
  ok: boolean;
  message: string | null;
}

function describeError(error: { message: string } | null): string | null {
  if (error === null) return null;

  // A RPC levanta exceção com mensagem em português para os casos previstos
  // (sem permissão, papel errado, responsável de outra organização). Repassar
  // o texto dela é mais útil que um genérico — nenhuma delas vaza dado.
  if (
    error.message.includes("sem permissao") ||
    error.message.includes("papel sem permissao") ||
    error.message.includes("nao pertence")
  ) {
    return error.message;
  }

  return "Não foi possível salvar a triagem.";
}

async function callTriage(input: {
  caseId: string;
  internalStatus?: string;
  priority?: string;
  assigneeId?: string;
  clearAssignee?: boolean;
}): Promise<TriageResult> {
  const supabase = await createClient();

  // Os parâmetros da RPC têm DEFAULT no Postgres, e os tipos gerados os
  // refletem como opcionais — omitir a chave é diferente de mandar `null`.
  // Montar o objeto assim mantém "não mexer" como ausência, que é a semântica
  // que a função implementa.
  const { error } = await supabase.rpc("triage_support_case", {
    p_case_id: input.caseId,
    ...(input.internalStatus === undefined ? {} : { p_internal_status: input.internalStatus }),
    ...(input.priority === undefined ? {} : { p_priority: input.priority }),
    ...(input.assigneeId === undefined ? {} : { p_assignee_id: input.assigneeId }),
    ...(input.clearAssignee === undefined ? {} : { p_clear_assignee: input.clearAssignee }),
  });

  const message = describeError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath("/atendimento");

  return { ok: true, message: null };
}

export async function changeInternalStatus(
  caseId: string,
  internalStatus: string,
): Promise<TriageResult> {
  return callTriage({ caseId, internalStatus });
}

export async function changePriority(caseId: string, priority: string): Promise<TriageResult> {
  return callTriage({ caseId, priority });
}

/**
 * "Assumir" resolve o responsável no SERVIDOR, a partir da sessão — nunca
 * aceita um id vindo do cliente. Assim o botão não vira um jeito de atribuir
 * atendimento a outra pessoa sem passar pela tela de responsável.
 */
export async function assignToMe(caseId: string): Promise<TriageResult> {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;

  if (userId === undefined) {
    return { ok: false, message: "Sessão expirada — atualize a página e tente de novo." };
  }

  // Assumir implica começar a atender: deixar em NOVO seria mentira na lista
  // de quem procura o que ainda não tem dono. Só promove a partir de NOVO —
  // quem já estava AGUARDANDO_CLIENTE não volta atrás por assumir.
  const current = await supabase
    .from("support_cases")
    .select("internal_status")
    .eq("id", caseId)
    .maybeSingle();

  const promote = current.data?.internal_status === "NOVO";

  return callTriage({
    caseId,
    assigneeId: userId,
    ...(promote ? { internalStatus: "EM_ATENDIMENTO" } : {}),
  });
}

export async function unassign(caseId: string): Promise<TriageResult> {
  return callTriage({ caseId, clearAssignee: true });
}
