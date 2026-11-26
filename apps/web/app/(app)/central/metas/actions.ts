"use server";

import { revalidatePath } from "next/cache";

import { currentMembership } from "../../../../lib/membership";
import {
  lerAlvoMetaFinanceira,
  lerData,
  lerEscopoMetaFinanceira,
  lerMarketplaceDaMeta,
  lerMes,
  lerNota,
  lerPercentual,
  lerTipoMetaFinanceira,
  lerValorEmReais,
  doMarketplaceDaMeta,
} from "../../../../lib/metas-imposto";
import { createClient } from "../../../../lib/supabase/server";

/**
 * Metas e imposto (D-395) — Server Actions diretas sob RLS, sem RPC: as
 * policies de `monthly_goals` e `tax_rates` exigem ADMIN/GESTOR
 * (`has_org_role`), o padrão de `replenishment_settings` (D-144/D-361). A
 * autorização mora no banco; a tela só traduz o erro quando a policy nega.
 *
 * As gravações são UPSERT pela chave natural — (organização, mês), (organização,
 * mês, marketplace) e (organização, início da vigência): cadastrar de novo o
 * mesmo mês corrige a meta, em vez de recusar com "já existe".
 *
 * D-473 (C-66): a meta GERAL continua em `monthly_goals`; a de cada
 * marketplace vai em `monthly_goals_marketplace`, com a mesma RLS.
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

export async function salvarMetaDoMarketplace(
  _anterior: ResultadoDoCadastro,
  formData: FormData,
): Promise<ResultadoDoCadastro> {
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

  if (membership.organizationId === null) return { ...SEM_ERRO, mensagem: "Sessão sem organização — atualize a página." };

  const marketplace = lerMarketplaceDaMeta(texto(formData, "marketplace"));
  const mes = lerMes(texto(formData, "month"));
  const valor = lerValorEmReais(texto(formData, "revenue_goal"));
  const nota = lerNota(texto(formData, "note"));
  const erros: Record<string, string> = {};

  if (!marketplace.ok) erros.marketplace = marketplace.erro;
  if (!mes.ok) erros.month = mes.erro;
  if (!valor.ok) erros.revenue_goal = valor.erro;
  if (!nota.ok) erros.note = nota.erro;

  if (!marketplace.ok || !mes.ok || !valor.ok || !nota.ok) return { ...SEM_ERRO, erros };

  const { data, error } = await supabase
    .from("monthly_goals_marketplace")
    .upsert(
      {
        organization_id: membership.organizationId,
        month: mes.valor,
        marketplace: marketplace.valor,
        revenue_goal: valor.valor,
        note: nota.valor,
      },
      { onConflict: "organization_id,month,marketplace" },
    )
    .select("id");

  if (error !== null) {
    // A web chega antes da migration de D-473: tabela ausente não é "não foi possível".
    if (error.code === "PGRST205" || error.code === "42P01") {
      return { ...SEM_ERRO, mensagem: "As metas por marketplace ainda estão sendo ativadas neste ambiente." };
    }

    return traduzir(error);
  }

  if (data.length === 0) return { ...SEM_ERRO, mensagem: "A meta não foi gravada: você não tem permissão." };

  revalidar();

  return { ok: true, mensagem: `Meta ${doMarketplaceDaMeta(marketplace.valor)} salva.`, erros: {} };
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

export async function salvarMetaFinanceira(
  _anterior: ResultadoDoCadastro,
  formData: FormData,
): Promise<ResultadoDoCadastro> {
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

  if (membership.organizationId === null) return { ...SEM_ERRO, mensagem: "Sessão sem organização — atualize a página." };

  const mes = lerMes(texto(formData, "month"));
  const tipo = lerTipoMetaFinanceira(texto(formData, "metric_kind"));
  const escopo = lerEscopoMetaFinanceira(texto(formData, "scope_kind"));
  const scopeRefRaw = texto(formData, "scope_ref").trim();
  const nota = lerNota(texto(formData, "note"));
  const erros: Record<string, string> = {};

  if (!mes.ok) erros.month = mes.erro;
  if (!tipo.ok) erros.metric_kind = tipo.erro;
  if (!escopo.ok) erros.scope_kind = escopo.erro;
  if (!nota.ok) erros.note = nota.erro;

  const alvo = tipo.ok ? lerAlvoMetaFinanceira(texto(formData, "target_value"), tipo.valor) : null;
  if (alvo !== null && !alvo.ok) erros.target_value = alvo.erro;

  if (escopo.ok && escopo.valor !== "global" && scopeRefRaw === "") {
    erros.scope_ref = "Informe qual marketplace, conta ou marca esta meta acompanha.";
  }

  if (!mes.ok || !tipo.ok || !escopo.ok || !nota.ok || alvo === null || !alvo.ok || Object.keys(erros).length > 0) {
    return { ...SEM_ERRO, erros };
  }

  const db = supabase as unknown as {
    from: (table: string) => {
      insert: (payload: Record<string, unknown>) => {
        select: (cols: string) => Promise<{ data: readonly unknown[] | null; error: { message: string; code?: string } | null }>;
      };
    };
  };

  const { data, error } = await db
    .from("financial_goals")
    .insert({
      organization_id: membership.organizationId,
      month: mes.valor,
      metric_kind: tipo.valor,
      scope_kind: escopo.valor,
      scope_ref: escopo.valor === "global" ? null : scopeRefRaw.slice(0, 80),
      target_value: alvo.valor,
      note: nota.valor,
    })
    .select("id");

  if (error !== null) {
    if (error.code === "PGRST205" || error.code === "42P01") {
      return { ...SEM_ERRO, mensagem: "As metas financeiras expandidas ainda estão sendo ativadas neste ambiente." };
    }
    if (error.code === "23505") {
      return { ...SEM_ERRO, mensagem: "Já existe uma meta para este mesmo indicador, mês e escopo. Remova a anterior para alterar." };
    }

    return traduzir(error);
  }

  if (data === null || data.length === 0) {
    return { ...SEM_ERRO, mensagem: "A meta financeira não foi gravada: você não tem permissão." };
  }

  revalidar();

  return { ok: true, mensagem: "Meta financeira salva.", erros: {} };
}

/** Remove uma meta ou uma vigência. O `id` vem do formulário; a RLS decide se a pessoa pode. */
export async function remover(formData: FormData): Promise<void> {
  const tabela = texto(formData, "tabela");
  const id = texto(formData, "id");

  if (
    (tabela !== "monthly_goals" &&
      tabela !== "monthly_goals_marketplace" &&
      tabela !== "tax_rates" &&
      tabela !== "financial_goals") ||
    id === ""
  ) {
    return;
  }

  const supabase = await createClient();

  if (tabela === "financial_goals") {
    const db = supabase as unknown as {
      from: (t: string) => { delete: () => { eq: (c: string, v: string) => Promise<unknown> } };
    };
    await db.from("financial_goals").delete().eq("id", id);
  } else {
    await supabase.from(tabela).delete().eq("id", id);
  }

  revalidar();
}
