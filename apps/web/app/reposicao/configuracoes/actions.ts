"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "../../../lib/supabase/server";

/**
 * Configuração de reposição (D-144, Fase 5D) — Server Actions diretas sob
 * RLS, sem RPC: `replenishment_settings_insert_admin`/`update`/`delete`
 * exigem ADMIN/GESTOR, mesmo padrão de `reply_templates` (D-111). A
 * autorização mora no banco; a tela só reflete o erro quando a policy nega.
 */

/**
 * `<form action>` de Server Component exige retorno void, então o erro viaja
 * pela URL (`?erro=`) e a página o exibe — server-only, sem `use client`.
 * Sucesso redireciona para a URL limpa, o que também evita re-submissão no
 * refresh (padrão POST-redirect-GET, de graça).
 */
function finish(message: string | null): never {
  revalidatePath("/reposicao/configuracoes");
  redirect(message === null ? "/reposicao/configuracoes" : `/reposicao/configuracoes?erro=${encodeURIComponent(message)}`);
}

function describeWriteError(error: { message: string; code?: string } | null): string | null {
  if (error === null) return null;

  if (error.code === "23505") {
    return "Já existe configuração para esse escopo — edite ou remova a existente.";
  }

  if (error.code === "42501") {
    return "Sem permissão: só ADMIN e GESTOR alteram a configuração de reposição.";
  }

  return `Não foi possível salvar: ${error.message}`;
}

function parseDays(raw: FormDataEntryValue | null, label: string, min: number): number | string {
  const parsed = Number.parseInt(typeof raw === "string" ? raw : "", 10);

  if (!Number.isFinite(parsed) || parsed < min || parsed > 365) {
    return `${label} precisa ser um número entre ${String(min)} e 365.`;
  }

  return parsed;
}

export async function createSetting(formData: FormData): Promise<void> {
  const supabase = await createClient();

  const membership = await supabase.from("organization_members").select("organization_id").maybeSingle();
  const organizationId = membership.data?.organization_id ?? null;

  if (organizationId === null) {
    finish("Sessão sem organização — atualize a página.");
  }

  const leadTime = parseDays(formData.get("lead_time_days"), "Prazo de reposição", 1);
  const coverage = parseDays(formData.get("target_coverage_days"), "Cobertura alvo", 1);
  const safety = parseDays(formData.get("safety_stock_days"), "Estoque de segurança", 0);

  const firstError = [leadTime, coverage, safety].find((v) => typeof v === "string");

  if (typeof firstError === "string") {
    finish(firstError);
  }

  const rawBrand = formData.get("supplier_brand");
  // "" = padrão da organização. A normalização espelha o CHECK do banco
  // (upper + trim) para o erro chegar legível, não como violação de check.
  const brand = typeof rawBrand === "string" && rawBrand.trim() !== "" ? rawBrand.trim().toUpperCase() : null;
  const rawNote = formData.get("policy_note");
  const note = typeof rawNote === "string" && rawNote.trim() !== "" ? rawNote.trim() : null;

  const { error } = await supabase.from("replenishment_settings").insert({
    organization_id: organizationId,
    supplier_brand: brand,
    sku_id: null,
    lead_time_days: leadTime as number,
    target_coverage_days: coverage as number,
    safety_stock_days: safety as number,
    policy_note: note,
  });

  finish(describeWriteError(error));
}

export async function updateSetting(formData: FormData): Promise<void> {
  const supabase = await createClient();
  const id = formData.get("id");

  if (typeof id !== "string" || id === "") {
    finish("Configuração não identificada — atualize a página.");
  }

  const leadTime = parseDays(formData.get("lead_time_days"), "Prazo de reposição", 1);
  const coverage = parseDays(formData.get("target_coverage_days"), "Cobertura alvo", 1);
  const safety = parseDays(formData.get("safety_stock_days"), "Estoque de segurança", 0);

  const firstError = [leadTime, coverage, safety].find((v) => typeof v === "string");

  if (typeof firstError === "string") {
    finish(firstError);
  }

  // O ESCOPO é identidade e não é editável — mudar a marca de uma regra
  // existente re-atribuiria silenciosamente a política de outro conjunto de
  // SKUs. Mesma regra de identidade fixa de `notification_preferences` (D-076).
  const { error } = await supabase
    .from("replenishment_settings")
    .update({
      lead_time_days: leadTime as number,
      target_coverage_days: coverage as number,
      safety_stock_days: safety as number,
    })
    .eq("id", id);

  finish(describeWriteError(error));
}

export async function deleteSetting(formData: FormData): Promise<void> {
  const supabase = await createClient();
  const id = formData.get("id");

  if (typeof id !== "string" || id === "") {
    finish("Configuração não identificada — atualize a página.");
  }

  const { error } = await supabase.from("replenishment_settings").delete().eq("id", id);
  finish(describeWriteError(error));
}
