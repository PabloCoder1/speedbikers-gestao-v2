"use server";

import { revalidatePath } from "next/cache";

import { validarRegra, type CampoDaRegra } from "../../../lib/replenishment-rule";
import { currentMembership } from "../../../lib/membership";
import { createClient } from "../../../lib/supabase/server";

/**
 * Configuração de reposição (D-144, Fase 5D; refeita em D-361) — Server Actions
 * diretas sob RLS, sem RPC: `replenishment_settings_insert_admin`/`update`/
 * `delete` exigem ADMIN/GESTOR, mesmo padrão de `reply_templates` (D-111). A
 * autorização mora no banco; a tela só reflete o erro quando a policy nega.
 *
 * ## D-361: o resultado VOLTA, não viaja pela URL
 *
 * Eram `<form action>` de Server Component, com o erro em `?erro=` e redirect
 * no sucesso. O formulário agora mora numa gaveta (`gaveta-regra.tsx`) com
 * `useActionState`: o erro chega NO CAMPO que o causou, a gaveta só fecha
 * quando salvou, e o `revalidatePath` faz o Next devolver a página atualizada
 * na mesma resposta (Next 16, "A single response carries data and UI").
 *
 * `/reposicao` é revalidada junto: a regra é o que decide a sugestão de lá, e
 * voltar para a reposição depois de salvar não pode mostrar a política velha.
 */

export interface ResultadoDaRegra {
  readonly ok: boolean;
  /** A frase geral: sucesso, permissão, conflito de escopo. */
  readonly mensagem: string | null;
  readonly erros: Partial<Record<CampoDaRegra | "supplier_brand", string>>;
}

const SEM_ERRO: ResultadoDaRegra = { ok: false, mensagem: null, erros: {} };

function revalidar(): void {
  revalidatePath("/reposicao/configuracoes");
  revalidatePath("/reposicao");
}

function texto(formData: FormData, campo: string): string {
  const valor = formData.get(campo);

  return typeof valor === "string" ? valor : "";
}

function traduzirErroDoBanco(error: { message: string; code?: string }): ResultadoDaRegra {
  if (error.code === "23505") {
    return {
      ...SEM_ERRO,
      erros: { supplier_brand: "Esse escopo já tem regra. Feche e edite a regra existente." },
    };
  }

  if (error.code === "42501") {
    return { ...SEM_ERRO, mensagem: "Sem permissão: só ADMIN e GESTOR alteram a configuração de reposição." };
  }

  if (error.code === "23514" && error.message.includes("max_covers_window")) {
    return {
      ...SEM_ERRO,
      erros: { max_coverage_days: "O teto precisa ser maior ou igual a prazo + segurança + cobertura." },
    };
  }

  return { ...SEM_ERRO, mensagem: `Não foi possível salvar: ${error.message}` };
}

/**
 * Cria (sem `id`) ou edita (com `id`) uma regra.
 *
 * O ESCOPO só é lido na criação. Na edição ele é identidade e não muda: trocar
 * a marca de uma regra existente reatribuiria a política de outro conjunto de
 * SKUs em silêncio (a mesma regra de identidade fixa de D-076). A nota passa a
 * ser editável — em D-144 ela só era gravada na criação, e corrigir o motivo de
 * uma regra exigia removê-la e criá-la de novo.
 */
export async function salvarRegra(_anterior: ResultadoDaRegra, formData: FormData): Promise<ResultadoDaRegra> {
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

  if (membership.organizationId === null) {
    return { ...SEM_ERRO, mensagem: "Sessão sem organização — atualize a página." };
  }

  const validacao = validarRegra({
    prazo: texto(formData, "lead_time_days"),
    cobertura: texto(formData, "target_coverage_days"),
    seguranca: texto(formData, "safety_stock_days"),
    teto: texto(formData, "max_coverage_days"),
    nota: texto(formData, "policy_note"),
  });

  if (!validacao.ok) {
    return { ...SEM_ERRO, erros: validacao.erros };
  }

  const { prazo, cobertura, seguranca, teto, nota } = validacao.valores;
  const id = texto(formData, "id");

  if (id !== "") {
    // `.select` para distinguir "salvou" de "a RLS filtrou a linha": sem ele, um
    // UPDATE que alcança zero linhas volta sem erro e a tela diria "salvo".
    const { data, error } = await supabase
      .from("replenishment_settings")
      .update({
        lead_time_days: prazo,
        target_coverage_days: cobertura,
        safety_stock_days: seguranca,
        max_coverage_days: teto,
        policy_note: nota,
      })
      .eq("id", id)
      .select("id");

    if (error !== null) return traduzirErroDoBanco(error);

    if (data.length === 0) {
      return {
        ...SEM_ERRO,
        mensagem: "A regra não foi alterada: ela foi removida por outra pessoa ou você não tem permissão.",
      };
    }

    revalidar();

    return { ok: true, mensagem: "Regra atualizada.", erros: {} };
  }

  // "" = padrão da organização. A normalização espelha o CHECK do banco
  // (upper + trim) para o erro chegar legível, não como violação de check.
  const marcaBruta = texto(formData, "supplier_brand").trim();
  const marca = marcaBruta === "" ? null : marcaBruta.toUpperCase();

  if (marca !== null && marca.length > 60) {
    return { ...SEM_ERRO, erros: { supplier_brand: "O nome da marca tem mais de 60 caracteres." } };
  }

  const { error } = await supabase.from("replenishment_settings").insert({
    organization_id: membership.organizationId,
    supplier_brand: marca,
    sku_id: null,
    lead_time_days: prazo,
    target_coverage_days: cobertura,
    safety_stock_days: seguranca,
    max_coverage_days: teto,
    policy_note: nota,
  });

  if (error !== null) return traduzirErroDoBanco(error);

  revalidar();

  return {
    ok: true,
    mensagem: marca === null ? "Padrão da organização criado." : `Regra da marca ${marca} criada.`,
    erros: {},
  };
}

export async function removerRegra(id: string): Promise<{ ok: boolean; mensagem: string }> {
  if (id === "") {
    return { ok: false, mensagem: "Regra não identificada — atualize a página." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.from("replenishment_settings").delete().eq("id", id).select("id");

  if (error !== null) {
    return { ok: false, mensagem: traduzirErroDoBanco(error).mensagem ?? "Não foi possível remover a regra." };
  }

  if (data.length === 0) {
    return { ok: false, mensagem: "A regra não foi removida: ela já não existe ou você não tem permissão." };
  }

  revalidar();

  return { ok: true, mensagem: "Regra removida." };
}
