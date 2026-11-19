"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "../../../lib/supabase/server";

/**
 * Central de Ações (Fase 6, D-064) — Server Action (D-012): escrita simples
 * no escopo do usuário, sem segredo, só chama `update_action_status`
 * (security definer, refaz a autorização por conta própria). Mesmo padrão de
 * `apps/web/app/(app)/vinculacoes/actions.ts`.
 */

export interface ActionResult {
  ok: boolean;
  message: string | null;
}

async function updateStatus(id: string, status: string, assigneeId?: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("update_action_status", {
    p_id: id,
    p_status: status,
    ...(assigneeId !== undefined ? { p_assignee_id: assigneeId } : {}),
  });

  if (error !== null) {
    return { ok: false, message: "Não foi possível atualizar a ação." };
  }

  revalidatePath("/acoes");

  return { ok: true, message: null };
}

/**
 * "Assumir": em_andamento + eu como responsável — uma ação só, não duas chamadas.
 * D-778: o responsável é derivado da sessão no servidor (`auth.getUser()`), nunca
 * de parâmetro vindo do navegador (mesma regra de `assignToMe` no atendimento).
 */
export async function claimAction(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: auth, error: authError } = await supabase.auth.getUser();

  if (authError !== null) {
    return {
      ok: false,
      message:
        authError.status === 401 || authError.status === 403 || authError.name === "AuthSessionMissingError"
          ? "Sessão expirada — atualize a página e tente de novo."
          : "Não foi possível confirmar sua sessão — tente de novo.",
    };
  }

  return updateStatus(id, "em_andamento", auth.user.id);
}

export async function resolveAction(id: string): Promise<ActionResult> {
  return updateStatus(id, "resolvido");
}

export async function dismissAction(id: string): Promise<ActionResult> {
  return updateStatus(id, "descartado");
}

/**
 * Memória de decisões operacionais (Fase 6, `docs/PROMPT_MASTER.md` secao
 * 29) — chama `create_action_decision` (security definer), que captura o
 * `baseline_snapshot` na hora. Sem RPC de leitura própria: a página busca
 * `action_decisions`/`action_outcomes` direto sob RLS, mesmo padrão do resto
 * do produto (Modelo A, D-012).
 */
export async function registerDecision(actionId: string, decision: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("create_action_decision", {
    p_action_id: actionId,
    p_decision: decision,
  });

  if (error !== null) {
    return { ok: false, message: "Não foi possível registrar a decisão." };
  }

  revalidatePath("/acoes");

  return { ok: true, message: null };
}
