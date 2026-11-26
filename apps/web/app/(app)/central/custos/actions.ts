"use server";

import { revalidatePath } from "next/cache";

import {
  lerFormularioDespesa,
  lerFormularioEntidadeFiscal,
  lerFormularioVigenciaTributaria,
} from "../../../../lib/custos-fiscal";
import { lerMes, lerNota } from "../../../../lib/metas-imposto";
import { currentMembership } from "../../../../lib/membership";
import { createClient } from "../../../../lib/supabase/server";
import type { ResultadoDoCadastro } from "../metas/actions";

/**
 * Custos operacionais e entidades fiscais (`/central/custos`) — Server Actions
 * diretas sob RLS (`ADMIN` e `GESTOR`), seguindo o mesmo padrão de
 * `/central/metas` e `/central/limites`.
 */

const SEM_ERRO: ResultadoDoCadastro = { ok: false, mensagem: null, erros: {} };

interface DbErro {
  readonly message: string;
  readonly code?: string;
}

interface TabelaGenerica {
  insert: (payload: Record<string, unknown>) => {
    select: (cols: string) => Promise<{ data: readonly Record<string, unknown>[] | null; error: DbErro | null }>;
  };
  upsert: (
    payload: Record<string, unknown>,
    opts: { onConflict: string },
  ) => {
    select: (cols: string) => Promise<{ data: readonly Record<string, unknown>[] | null; error: DbErro | null }>;
  };
  update: (payload: Record<string, unknown>) => {
    eq: (col: string, val: string) => {
      eq: (col2: string, val2: string) => Promise<{ error: DbErro | null }>;
    };
  };
  delete: () => {
    eq: (col: string, val: string) => {
      eq: (col2: string, val2: string) => Promise<{ error: DbErro | null }>;
    };
  };
}

function tabela(supabase: Awaited<ReturnType<typeof createClient>>, nome: string): TabelaGenerica {
  return (supabase as unknown as { from: (t: string) => TabelaGenerica }).from(nome);
}

function campoDe(formData: FormData): (nome: string) => string {
  return (nome: string): string => {
    const v = formData.get(nome);
    return typeof v === "string" ? v : "";
  };
}

function revalidar(): void {
  revalidatePath("/central/custos");
  revalidatePath("/central");
  revalidatePath("/central/metas");
}

function traduzirErro(error: DbErro, entidade: string): ResultadoDoCadastro {
  if (error.code === "PGRST205" || error.code === "42P01") {
    return {
      ...SEM_ERRO,
      mensagem:
        "As tabelas financeiras ainda não foram aplicadas neste banco (migration 20261126180000 pendente).",
    };
  }
  if (error.code === "42501") {
    return { ...SEM_ERRO, mensagem: `Sem permissão: só ADMIN e GESTOR alteram ${entidade}.` };
  }
  if (error.code === "23505") {
    return { ...SEM_ERRO, mensagem: `Já existe um registro igual para ${entidade} (duplicidade bloqueada).` };
  }
  if (error.code === "23514") {
    return { ...SEM_ERRO, mensagem: "O banco recusou os valores informados: confira os campos." };
  }

  return { ...SEM_ERRO, mensagem: `Não foi possível salvar: ${error.message}` };
}

export async function salvarDespesa(
  _anterior: ResultadoDoCadastro,
  formData: FormData,
): Promise<ResultadoDoCadastro> {
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

  if (membership.organizationId === null) {
    return { ...SEM_ERRO, mensagem: "Sessão sem organização — atualize a página." };
  }

  const lido = lerFormularioDespesa(campoDe(formData));
  if (!lido.ok) return { ...SEM_ERRO, erros: lido.erros };

  const { data: usuario } = await supabase.auth.getUser();
  const userId = usuario.user?.id ?? null;

  // Chave de idempotência opcional quando a despesa é recorrente mensal na mesma competência e nome
  const slugNome = lido.valor.name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const idempotencyKey =
    lido.valor.recurrence === "mensal"
      ? `exp:${lido.valor.competence_date.slice(0, 7)}:${lido.valor.category}:${slugNome}`
      : null;

  const payload = {
    organization_id: membership.organizationId,
    ...lido.valor,
    idempotency_key: idempotencyKey,
    created_by: userId,
    updated_by: userId,
  };

  const { data, error } = await tabela(supabase, "operational_expenses").insert(payload).select("id");

  if (error !== null) return traduzirErro(error, "despesas operacionais");
  if (data === null || data.length === 0) {
    return { ...SEM_ERRO, mensagem: "A despesa não foi gravada: verifique suas permissões." };
  }

  const createdId = typeof data[0]?.id === "string" ? data[0].id : null;
  if (createdId !== null) {
    await tabela(supabase, "operational_expense_history")
      .insert({
        organization_id: membership.organizationId,
        expense_id: createdId,
        action: "created",
        after_data: payload,
        changed_by: userId,
      })
      .select("id");
  }

  revalidar();

  return { ok: true, mensagem: "Despesa operacional salva e conectada à DRE do período.", erros: {} };
}

export async function marcarDespesaPaga(formData: FormData): Promise<void> {
  const id = campoDe(formData)("id").trim();
  const valorRealizadoTexto = campoDe(formData)("actual_amount").trim();
  if (id === "") return;

  const supabase = await createClient();
  const membership = await currentMembership(supabase);
  if (membership.organizationId === null) return;

  const valor = Number(valorRealizadoTexto);
  const hoje = new Date().toISOString().slice(0, 10);

  await tabela(supabase, "operational_expenses")
    .update({
      status: "paga",
      paid_date: hoje,
      ...(Number.isFinite(valor) && valor >= 0 ? { actual_amount: Math.round(valor * 100) / 100 } : {}),
    })
    .eq("id", id)
    .eq("organization_id", membership.organizationId);

  revalidar();
}

export async function removerDespesa(formData: FormData): Promise<void> {
  const id = campoDe(formData)("id").trim();
  if (id === "") return;

  const supabase = await createClient();
  const membership = await currentMembership(supabase);
  if (membership.organizationId === null) return;

  await tabela(supabase, "operational_expenses")
    .delete()
    .eq("id", id)
    .eq("organization_id", membership.organizationId);

  revalidar();
}

export async function salvarEntidadeFiscal(
  _anterior: ResultadoDoCadastro,
  formData: FormData,
): Promise<ResultadoDoCadastro> {
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

  if (membership.organizationId === null) {
    return { ...SEM_ERRO, mensagem: "Sessão sem organização — atualize a página." };
  }

  const lido = lerFormularioEntidadeFiscal(campoDe(formData));
  if (!lido.ok) return { ...SEM_ERRO, erros: lido.erros };

  const { data, error } = await tabela(supabase, "fiscal_entities")
    .upsert(
      {
        organization_id: membership.organizationId,
        ...lido.valor,
      },
      { onConflict: "organization_id,cnpj" },
    )
    .select("id");

  if (error !== null) return traduzirErro(error, "entidades fiscais");
  if (data === null || data.length === 0) {
    return { ...SEM_ERRO, mensagem: "A entidade fiscal não foi gravada: verifique suas permissões." };
  }

  revalidar();

  return { ok: true, mensagem: "Entidade fiscal (CNPJ) salva.", erros: {} };
}

export async function salvarVigenciaTributaria(
  _anterior: ResultadoDoCadastro,
  formData: FormData,
): Promise<ResultadoDoCadastro> {
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

  if (membership.organizationId === null) {
    return { ...SEM_ERRO, mensagem: "Sessão sem organização — atualize a página." };
  }

  const lido = lerFormularioVigenciaTributaria(campoDe(formData));
  if (!lido.ok) return { ...SEM_ERRO, erros: lido.erros };

  const { data, error } = await tabela(supabase, "fiscal_entity_tax_configs")
    .upsert(
      {
        organization_id: membership.organizationId,
        ...lido.valor,
        is_estimate: !lido.valor.validated_by_accountant,
      },
      { onConflict: "fiscal_entity_id,valid_from" },
    )
    .select("id");

  if (error !== null) return traduzirErro(error, "vigências tributárias");
  if (data === null || data.length === 0) {
    return { ...SEM_ERRO, mensagem: "A vigência tributária não foi gravada: verifique suas permissões." };
  }

  revalidar();

  return { ok: true, mensagem: "Vigência tributária salva preservando o histórico anterior.", erros: {} };
}

export async function removerEntidadeFiscal(formData: FormData): Promise<void> {
  const id = campoDe(formData)("id").trim();
  if (id === "") return;

  const supabase = await createClient();
  const membership = await currentMembership(supabase);
  if (membership.organizationId === null) return;

  await tabela(supabase, "fiscal_entities")
    .delete()
    .eq("id", id)
    .eq("organization_id", membership.organizationId);

  revalidar();
}

export async function vincularContaEntidade(
  _anterior: ResultadoDoCadastro,
  formData: FormData,
): Promise<ResultadoDoCadastro> {
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

  if (membership.organizationId === null) {
    return { ...SEM_ERRO, mensagem: "Sessão sem organização — atualize a página." };
  }

  const campos = campoDe(formData);
  const fiscalEntityId = campos("fiscal_entity_id").trim();
  const contaComposta = campos("account_ref").trim();
  const erros: Record<string, string> = {};

  if (fiscalEntityId === "") erros.fiscal_entity_id = "Selecione o CNPJ.";
  if (!contaComposta.includes(":")) erros.account_ref = "Selecione a conta de marketplace.";

  const [marketplace, accountId] = contaComposta.split(":");
  if ((marketplace !== "MERCADO_LIVRE" && marketplace !== "SHOPEE") || !accountId) {
    erros.account_ref = "Conta inválida.";
  }

  if (Object.keys(erros).length > 0) return { ...SEM_ERRO, erros };

  const payload =
    marketplace === "MERCADO_LIVRE"
      ? {
          organization_id: membership.organizationId,
          fiscal_entity_id: fiscalEntityId,
          marketplace: "MERCADO_LIVRE",
          ml_account_id: accountId,
          shopee_shop_id: null,
        }
      : {
          organization_id: membership.organizationId,
          fiscal_entity_id: fiscalEntityId,
          marketplace: "SHOPEE",
          ml_account_id: null,
          shopee_shop_id: accountId,
        };

  const { data, error } = await tabela(supabase, "fiscal_entity_accounts").insert(payload).select("id");

  if (error !== null) return traduzirErro(error, "vínculo conta → CNPJ");
  if (data === null || data.length === 0) {
    return { ...SEM_ERRO, mensagem: "O vínculo não foi gravado: verifique suas permissões." };
  }

  revalidar();

  return { ok: true, mensagem: "Conta vinculada à entidade fiscal (CNPJ).", erros: {} };
}

export async function removerVinculoContaEntidade(formData: FormData): Promise<void> {
  const id = campoDe(formData)("id").trim();
  if (id === "") return;

  const supabase = await createClient();
  const membership = await currentMembership(supabase);
  if (membership.organizationId === null) return;

  await tabela(supabase, "fiscal_entity_accounts")
    .delete()
    .eq("id", id)
    .eq("organization_id", membership.organizationId);

  revalidar();
}

export async function salvarFechamentoMensal(
  _anterior: ResultadoDoCadastro,
  formData: FormData,
): Promise<ResultadoDoCadastro> {
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

  if (membership.organizationId === null) {
    return { ...SEM_ERRO, mensagem: "Sessão sem organização — atualize a página." };
  }

  const campos = campoDe(formData);
  const mes = lerMes(campos("month"));
  const statusRaw = campos("status").trim();
  const status = statusRaw === "aberto" || statusRaw === "fechado" || statusRaw === "reaberto" ? statusRaw : null;
  const nota = lerNota(campos("notes"));
  const erros: Record<string, string> = {};

  if (!mes.ok) erros.month = mes.erro;
  if (status === null) erros.status = "Selecione o status do fechamento.";
  if (!nota.ok) erros.notes = nota.erro;

  if (!mes.ok || status === null || !nota.ok) return { ...SEM_ERRO, erros };

  const { data: usuario } = await supabase.auth.getUser();
  const agora = new Date().toISOString();

  const { data, error } = await tabela(supabase, "monthly_financial_closings")
    .upsert(
      {
        organization_id: membership.organizationId,
        month: mes.valor,
        status,
        notes: nota.valor,
        dre_snapshot: {
          recorded_at: agora,
          competence_month: mes.valor,
          status,
        },
        closed_by: status === "fechado" ? (usuario.user?.id ?? null) : null,
        closed_at: status === "fechado" ? agora : null,
      },
      { onConflict: "organization_id,month" },
    )
    .select("id");

  if (error !== null) return traduzirErro(error, "fechamento mensal");
  if (data === null || data.length === 0) {
    return { ...SEM_ERRO, mensagem: "O fechamento não foi gravado: verifique suas permissões." };
  }

  revalidar();

  return {
    ok: true,
    mensagem:
      status === "fechado"
        ? "Competência fechada e registrada para auditoria."
        : `Status da competência atualizado para ${status}.`,
    erros: {},
  };
}
