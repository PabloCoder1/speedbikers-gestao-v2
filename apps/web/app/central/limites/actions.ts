"use server";

import { revalidatePath } from "next/cache";

import { lerFormularioDosLimites } from "../../../lib/limites-central";
import { currentMembership } from "../../../lib/membership";
import { createClient } from "../../../lib/supabase/server";
import type { ResultadoDoCadastro } from "../metas/actions";

/**
 * Limites da central (D-408) — Server Actions diretas sob RLS, como Metas e
 * imposto: as policies de `central_thresholds` exigem ADMIN/GESTOR, e a tela
 * só traduz o erro quando a policy nega.
 */

const SEM_ERRO: ResultadoDoCadastro = { ok: false, mensagem: null, erros: {} };

function revalidar(): void {
  revalidatePath("/central/limites");
  revalidatePath("/central");
  revalidatePath("/central/ads");
}

export async function salvarLimites(_anterior: ResultadoDoCadastro, formData: FormData): Promise<ResultadoDoCadastro> {
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

  if (membership.organizationId === null) return { ...SEM_ERRO, mensagem: "Sessão sem organização — atualize a página." };

  const lido = lerFormularioDosLimites((nome) => {
    const valor = formData.get(nome);

    return typeof valor === "string" ? valor : "";
  });

  if (!lido.ok) return { ...SEM_ERRO, erros: lido.erros };

  // `.select` para distinguir "salvou" de "a RLS filtrou a linha".
  const { data, error } = await supabase
    .from("central_thresholds")
    .upsert({ organization_id: membership.organizationId, ...lido.valores }, { onConflict: "organization_id" })
    .select("organization_id");

  if (error !== null) {
    if (error.code === "42501") return { ...SEM_ERRO, mensagem: "Sem permissão: só ADMIN e GESTOR mudam os limites." };
    if (error.code === "23514") return { ...SEM_ERRO, mensagem: "O banco recusou os valores: confira os campos." };

    return { ...SEM_ERRO, mensagem: `Não foi possível salvar: ${error.message}` };
  }

  if (data.length === 0) return { ...SEM_ERRO, mensagem: "Os limites não foram gravados: você não tem permissão." };

  revalidar();

  return { ok: true, mensagem: "Limites salvos. A central já julga com eles.", erros: {} };
}

/** Apaga a linha da organização: a central volta aos padrões. A RLS decide se a pessoa pode. */
export async function voltarAosPadroes(): Promise<void> {
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

  if (membership.organizationId === null) return;

  await supabase.from("central_thresholds").delete().eq("organization_id", membership.organizationId);

  revalidar();
}
