"use server";

import { revalidatePath } from "next/cache";

import { lerFormularioDoAlerta } from "../../../../lib/alerta-margem";
import { lerFormularioDosLimites } from "../../../../lib/limites-central";
import { currentMembership } from "../../../../lib/membership";
import { createClient } from "../../../../lib/supabase/server";
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

  if (membership.error !== null) {
    return { ...SEM_ERRO, mensagem: "Não foi possível confirmar sua organização — tente de novo." };
  }

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

    return { ...SEM_ERRO, mensagem: "Não foi possível salvar os limites. Tente novamente." };
  }

  if (data.length === 0) return { ...SEM_ERRO, mensagem: "Os limites não foram gravados: você não tem permissão." };

  revalidar();

  return { ok: true, mensagem: "Limites salvos. A central já julga com eles.", erros: {} };
}

/** Apaga a linha da organização: a central volta aos padrões. A RLS decide se a pessoa pode. */
export async function voltarAosPadroes(): Promise<string | null> {
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

  if (membership.error !== null) return "Não foi possível confirmar sua organização — tente de novo.";
  if (membership.organizationId === null) return "Sessão sem organização. Atualize a página para conferir seu acesso.";

  const { data, error } = await supabase.from("central_thresholds").delete().eq("organization_id", membership.organizationId).select("organization_id");

  if (error !== null) return "Não foi possível confirmar a restauração. Confira os limites antes de tentar novamente.";
  if (data.length === 0) return "Nada foi removido. Os limites podem ter mudado ou seu acesso foi alterado. Atualize a página para conferir.";

  revalidar();
  return null;
}

/**
 * D-858 — o alerta de venda abaixo da margem: liga/desliga, as duas metas, as
 * marcas importadas e os e-mails. Direto sob RLS, como os limites: as policies
 * de `margin_alert_settings` exigem ADMIN/GESTOR.
 */
export async function salvarAlertaDeMargem(_anterior: ResultadoDoCadastro, formData: FormData): Promise<ResultadoDoCadastro> {
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

  if (membership.organizationId === null) return { ...SEM_ERRO, mensagem: "Sessão sem organização — atualize a página." };

  const lido = lerFormularioDoAlerta((nome) => {
    const valor = formData.get(nome);

    return typeof valor === "string" ? valor : "";
  });

  if (!lido.ok) return { ...SEM_ERRO, erros: lido.erros };

  const { data: usuario } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("margin_alert_settings")
    .upsert(
      {
        organization_id: membership.organizationId,
        enabled: lido.valores.enabled,
        default_min_margin: lido.valores.default_min_margin,
        imported_min_margin: lido.valores.imported_min_margin,
        imported_brands: [...lido.valores.imported_brands],
        email_recipients: [...lido.valores.email_recipients],
        updated_by: usuario.user?.id ?? null,
      },
      { onConflict: "organization_id" },
    )
    .select("organization_id");

  if (error !== null) {
    if (error.code === "42501") return { ...SEM_ERRO, mensagem: "Sem permissão: só ADMIN e GESTOR mudam o alerta de margem." };
    if (error.code === "23514") return { ...SEM_ERRO, mensagem: "O banco recusou os valores: confira as metas e os e-mails." };

    return { ...SEM_ERRO, mensagem: `Não foi possível salvar: ${error.message}` };
  }

  if (data.length === 0) return { ...SEM_ERRO, mensagem: "O alerta não foi gravado: você não tem permissão." };

  revalidatePath("/central/limites");

  return {
    ok: true,
    mensagem: lido.valores.enabled
      ? `Alerta salvo. ${lido.valores.email_recipients.length === 0 ? "Sem e-mail cadastrado, o aviso cai só no sino." : `O aviso vai ao sino e a ${String(lido.valores.email_recipients.length)} e-mail(s).`}`
      : "Alerta desligado: nenhuma venda nova será julgada.",
    erros: {},
  };
}
