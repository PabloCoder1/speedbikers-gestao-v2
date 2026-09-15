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

/**
 * REMOVER DA ORGANIZAÇÃO (D-354) — apaga o vínculo e o alcance nas contas.
 *
 * O banco já sabia fazer isto desde D-175 (`organization_members_admin_writes`
 * é `for all`); faltava a tela. O que acontece, na ordem:
 *
 * 1. **o vínculo sai** — é a escrita guardada: `guard_last_admin` recusa o
 *    último ADMIN, e `log_member_access_change` grava `MEMBER_REMOVED`;
 * 2. **as permissões por conta saem** — sem vínculo, `has_account_access` já
 *    nega; apagar as linhas é para um convite futuro não ressuscitar um alcance
 *    que ninguém escolheu de novo. Cada uma grava `ACCOUNT_ACCESS_REVOKED`,
 *    que é o que de fato aconteceu.
 *
 * A conta no Auth continua existindo: ela pode pertencer a outra organização,
 * e apagá-la esbarraria no histórico (`actor_user_id` é `on delete restrict`).
 * Para só impedir a entrada sem apagar nada, a gaveta oferece "Suspender".
 */
export async function removeMember(organizationId: string, userId: string): Promise<AccessResult> {
  const supabase = await createClient();

  /*
    A PRÓPRIA CONTA não sai por aqui. O banco deixaria (se houver outro ADMIN),
    e o efeito seria a pessoa perder a tela no meio do clique. `getUser`, e não
    `getSession`: numa escrita, o id vem do Auth, não do cookie.
  */
  const { data: auth } = await supabase.auth.getUser();

  if (auth.user?.id === userId) {
    return { ok: false, message: "Você não pode remover o próprio acesso. Peça a outro ADMIN." };
  }

  const { data, error } = await supabase
    .from("organization_members")
    .delete()
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .select("user_id");

  if (error !== null) {
    return { ok: false, message: traduzir(error) };
  }

  // Zero linhas sem erro é a recusa da RLS num DELETE: a policy esconde a linha.
  if (data.length === 0) {
    return {
      ok: false,
      message: "Nada foi removido — a pessoa já não era membro, ou você não é ADMIN desta organização.",
    };
  }

  const contas = await supabase.from("ml_accounts").select("id").eq("organization_id", organizationId);

  if (contas.error === null && contas.data.length > 0) {
    const limpeza = await supabase
      .from("user_account_permissions")
      .delete()
      .eq("user_id", userId)
      .in(
        "ml_account_id",
        contas.data.map((conta) => conta.id),
      );

    if (limpeza.error !== null) {
      // O vínculo JÁ saiu, e sem ele nenhuma permissão vale. Dizer as duas coisas.
      revalidatePath("/usuarios");

      return {
        ok: false,
        message: "A pessoa foi removida, mas as permissões por conta não foram apagadas. Elas não valem sem o vínculo.",
      };
    }
  }

  revalidatePath("/usuarios");

  return { ok: true, message: null };
}
