"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "../../lib/supabase/server";

/**
 * Administração de Usuários (D-175) — Server Actions (D-012): escrita simples
 * no escopo do usuário, sem segredo.
 *
 * **A autorização NÃO está aqui.** Quem decide é o banco: as policies
 * `organization_members_admin_writes` e `user_account_permissions_admin_writes`
 * exigem ADMIN, e o trigger `guard_last_admin` impede o lockout. Estas funções
 * escrevem direto sob RLS (mesmo padrão de D-119) e apenas TRADUZEM a recusa
 * do banco para uma frase legível. Se alguém chamar isto sem ser ADMIN, o
 * banco recusa — a tela esconder o botão é conveniência, não segurança.
 */

export interface AccessResult {
  ok: boolean;
  message: string | null;
}

/**
 * A guarda do último ADMIN chega como `check_violation` (23514) com a
 * mensagem que a migration escreveu. Repassar a mensagem do banco é melhor
 * que inventar uma: ela diz o que fazer ("promova outro membro antes").
 */
function traduzir(error: { code?: string; message: string }): string {
  if (error.code === "23514" && error.message.includes("sem nenhum ADMIN")) {
    return "A organização ficaria sem nenhum ADMIN. Promova outro membro antes de rebaixar ou remover este.";
  }

  if (error.code === "42501" || error.message.toLowerCase().includes("row-level security")) {
    return "Só um ADMIN pode alterar acessos.";
  }

  return "Não foi possível aplicar a mudança.";
}

export async function changeMemberRole(
  organizationId: string,
  userId: string,
  role: string,
): Promise<AccessResult> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("organization_members")
    .update({ role })
    .eq("organization_id", organizationId)
    .eq("user_id", userId);

  if (error !== null) {
    return { ok: false, message: traduzir(error) };
  }

  revalidatePath("/usuarios");

  return { ok: true, message: null };
}

export async function grantAccountAccess(userId: string, mlAccountId: string): Promise<AccessResult> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("user_account_permissions")
    .insert({ user_id: userId, ml_account_id: mlAccountId });

  if (error !== null) {
    return { ok: false, message: traduzir(error) };
  }

  revalidatePath("/usuarios");

  return { ok: true, message: null };
}

export async function revokeAccountAccess(userId: string, mlAccountId: string): Promise<AccessResult> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("user_account_permissions")
    .delete()
    .eq("user_id", userId)
    .eq("ml_account_id", mlAccountId);

  if (error !== null) {
    return { ok: false, message: traduzir(error) };
  }

  revalidatePath("/usuarios");

  return { ok: true, message: null };
}
