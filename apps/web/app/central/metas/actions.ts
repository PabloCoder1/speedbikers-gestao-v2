"use server";

import { revalidatePath } from "next/cache";

import { currentMembership } from "../../../lib/membership";
import { lerData, lerMes, lerNota, lerPercentual, lerValorEmReais } from "../../../lib/metas-imposto";
import { createClient } from "../../../lib/supabase/server";

/**
 * Metas e imposto (D-395) — Server Actions diretas sob RLS, sem RPC: as
 * policies de `monthly_goals` e `tax_rates` exigem ADMIN/GESTOR
 * (`has_org_role`), o padrão de `replenishment_settings` (D-144/D-361). A
 * autorização mora no banco; a tela só traduz o erro quando a policy nega.
 *
 * As duas gravações são UPSERT pela chave natural — (organização, mês) e
 * (organização, início da vigência): cadastrar de novo o mesmo mês corrige a
 * meta, em vez de recusar com "já existe".
 */

export interface ResultadoDoCadastro {
  readonly ok: boolean;
  readonly mensagem: string | null;
  readonly erros: Partial<Record<string, string>>;
}

const SEM_ERRO: ResultadoDoCadastro = { ok: false, mensagem: null, erros: {} };

function revalidar(): void {
  revalidatePath("/central/metas");
  revalidatePath("/central");
  revalidatePath("/faturamento");
}

function texto(formData: FormData, campo: string): string {
  const valor = formData.get(campo);

  return typeof valor === "string" ? valor : "";
}

function traduzir(error: { message: string; code?: string }): ResultadoDoCadastro {
  if (error.code === "42501") {
    return { ...SEM_ERRO, mensagem: "Sem permissão: só ADMIN e GESTOR cadastram meta e alíquota." };
  }

  if (error.code === "23514") {
    return { ...SEM_ERRO, mensagem: "O banco recusou o valor: confira os campos." };
  }

  return { ...SEM_ERRO, mensagem: `Não foi possível salvar: ${error.message}` };
}

export async function salvarMeta(_anterior: ResultadoDoCadastro, formData: FormData): Promise<ResultadoDoCadastro> {
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

  if (membership.organizationId === null) return { ...SEM_ERRO, mensagem: "Sessão sem organização — atualize a página." };

  const mes = lerMes(texto(formData, "month"));
  const valor = lerValorEmReais(texto(formData, "revenue_goal"));
  const nota = lerNota(texto(formData, "note"));
  const erros: Record<string, string> = {};

  if (!mes.ok) erros.month = mes.erro;
  if (!valor.ok) erros.revenue_goal = valor.erro;
  if (!nota.ok) erros.note = nota.erro;

  if (!mes.ok || !valor.ok || !nota.ok) return { ...SEM_ERRO, erros };

  // `.select` para distinguir "salvou" de "a RLS filtrou a linha".
  const { data, error } = await supabase
    .from("monthly_goals")
    .upsert(
      { organization_id: membership.organizationId, month: mes.valor, revenue_goal: valor.valor, note: nota.valor },
      { onConflict: "organization_id,month" },
    )
    .select("id");

  if (error !== null) return traduzir(error);
  if (data.length === 0) return { ...SEM_ERRO, mensagem: "A meta não foi gravada: você não tem permissão." };

  revalidar();

  return { ok: true, mensagem: "Meta salva.", erros: {} };
}

export async function salvarAliquota(_anterior: ResultadoDoCadastro, formData: FormData): Promise<ResultadoDoCadastro> {
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

  if (membership.organizationId === null) return { ...SEM_ERRO, mensagem: "Sessão sem organização — atualize a página." };

  const desde = lerData(texto(formData, "valid_from"));
  const aliquota = lerPercentual(texto(formData, "rate"));
  const nota = lerNota(texto(formData, "note"));
  const erros: Record<string, string> = {};

  if (!desde.ok) erros.valid_from = desde.erro;
  if (!aliquota.ok) erros.rate = aliquota.erro;
  if (!nota.ok) erros.note = nota.erro;

  if (!desde.ok || !aliquota.ok || !nota.ok) return { ...SEM_ERRO, erros };

  const { data, error } = await supabase
    .from("tax_rates")
    .upsert(
      { organization_id: membership.organizationId, valid_from: desde.valor, rate: aliquota.valor, note: nota.valor },
      { onConflict: "organization_id,valid_from" },
    )
    .select("id");

  if (error !== null) return traduzir(error);
  if (data.length === 0) return { ...SEM_ERRO, mensagem: "A alíquota não foi gravada: você não tem permissão." };

  revalidar();

  return { ok: true, mensagem: "Alíquota salva.", erros: {} };
}

/** Remove uma meta ou uma vigência. O `id` vem do formulário; a RLS decide se a pessoa pode. */
export async function remover(formData: FormData): Promise<void> {
  const tabela = texto(formData, "tabela");
  const id = texto(formData, "id");

  if ((tabela !== "monthly_goals" && tabela !== "tax_rates") || id === "") return;

  const supabase = await createClient();

  await supabase.from(tabela).delete().eq("id", id);

  revalidar();
}
