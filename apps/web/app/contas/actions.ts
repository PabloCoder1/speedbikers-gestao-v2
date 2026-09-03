"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "../../lib/supabase/server";
import { currentMembership } from "../../lib/membership";

/**
 * Criação de conta Mercado Livre (docs/DATABASE.md, tabela `ml_accounts`).
 *
 * Server Action (D-012): escrita simples no escopo do usuário, sob RLS
 * (`ml_accounts_admin_writes`, só ADMIN). Diferente da conexão em si — que
 * precisa do `client_secret` e por isso passa pela `api`
 * (`apps/web/app/contas/connect-button.tsx`) — criar a linha da conta não
 * envolve segredo nenhum.
 */

export interface ActionResult {
  ok: boolean;
  message: string | null;
}

function describeInsertError(error: { message: string; code?: string } | null): string | null {
  if (error === null) return null;

  if (error.code === "23505") {
    return "Já existe uma conta com este identificador nesta organização.";
  }

  if (error.message.includes("ml_accounts_slug_check") || error.message.includes("slug")) {
    return "Identificador inválido — use só letras minúsculas, números e hífen, começando e terminando com letra ou número.";
  }

  if (error.message.includes("permission denied") || error.message.includes("row-level security")) {
    return "Você não tem permissão para cadastrar contas — só ADMIN pode.";
  }

  return "Não foi possível criar a conta.";
}

export async function createMlAccount(label: string, slug: string): Promise<ActionResult> {
  const supabase = await createClient();

  const trimmedLabel = label.trim();
  const trimmedSlug = slug.trim();

  if (trimmedLabel === "" || trimmedSlug === "") {
    return { ok: false, message: "Preencha o rótulo e o identificador." };
  }

  const membership = await currentMembership(supabase);

  if (membership.error !== null) {
    return { ok: false, message: "Não foi possível confirmar sua organização — tente de novo." };
  }

  if (membership.organizationId === null) {
    return { ok: false, message: "Sua conta não está associada a nenhuma organização." };
  }

  const { error } = await supabase.from("ml_accounts").insert({
    organization_id: membership.organizationId,
    label: trimmedLabel,
    slug: trimmedSlug,
  });

  const message = describeInsertError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath("/contas");

  return { ok: true, message: null };
}
