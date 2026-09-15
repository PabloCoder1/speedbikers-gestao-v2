"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "../lib/supabase/server";

/**
 * O NOME de uma pessoa (D-354) — pela própria pessoa ("Meu perfil") ou por um
 * ADMIN da organização dela (gaveta de `/usuarios`).
 *
 * Escrita direta sob RLS, como as outras Server Actions de acesso (D-175): quem
 * decide é `profiles_update_self_or_org_admin`. Esta função só traduz.
 */

export interface ResultadoDoPerfil {
  ok: boolean;
  message: string | null;
}

export async function updateProfileName(userId: string, fullName: string): Promise<ResultadoDoPerfil> {
  const nome = fullName.trim().replace(/\s+/g, " ");

  // O mesmo intervalo do `check` de `profiles.full_name`: recusar aqui dá a
  // frase certa, em vez do código de violação do banco.
  if (nome.length === 0 || nome.length > 200) {
    return { ok: false, message: "O nome precisa ter entre 1 e 200 caracteres." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.from("profiles").update({ full_name: nome }).eq("id", userId).select("id");

  if (error !== null) {
    return { ok: false, message: "Não foi possível salvar o nome." };
  }

  // Zero linhas sem erro é a recusa da RLS num UPDATE: a policy esconde a linha.
  if (data.length === 0) {
    return { ok: false, message: "Só a própria pessoa ou um ADMIN da organização dela pode mudar este nome." };
  }

  revalidatePath("/usuarios");

  return { ok: true, message: null };
}
