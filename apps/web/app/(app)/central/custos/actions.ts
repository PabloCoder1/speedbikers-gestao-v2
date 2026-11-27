"use server";

import { revalidatePath } from "next/cache";

import {
  lerFormularioDespesa,
  lerFormularioEntidadeFiscal,
  lerFormularioVigenciaTributaria,
  proximoMes,
} from "../../../../lib/custos-fiscal";
import { lerMes, lerNota } from "../../../../lib/metas-imposto";
import { lerNumero } from "../../../../lib/numero-ptbr";
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
      eq: (col2: string, val2: string) => {
        select: (cols: "id") => Promise<{ data: readonly { id: string }[] | null; error: DbErro | null }>;
      };
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
        "As tabelas financeiras ainda não foram aplicadas neste banco (migration 20261126233000 pendente).",
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

  // A trilha de auditoria em `operational_expense_history` é gravada automaticamente
  // pelo trigger `operational_expenses_audit` no Postgres (migration 20261126234000).
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

  const { data: usuario } = await supabase.auth.getUser();
  const userId = usuario.user?.id ?? null;

  const valorPt = lerNumero(valorRealizadoTexto);
  const valor = valorPt ?? Number(valorRealizadoTexto);
  const hoje = new Date().toISOString().slice(0, 10);
  const patch = {
    status: "paga",
    paid_date: hoje,
    updated_by: userId,
    ...(Number.isFinite(valor) && valor >= 0 ? { actual_amount: Math.round(valor * 100) / 100 } : {}),
  };

  await tabela(supabase, "operational_expenses")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", membership.organizationId);

  revalidar();
}

export async function cancelarDespesa(formData: FormData): Promise<void> {
  const id = campoDe(formData)("id").trim();
  if (id === "") return;

  const supabase = await createClient();
  const membership = await currentMembership(supabase);
  if (membership.organizationId === null) return;

  const { data: usuario } = await supabase.auth.getUser();
  const userId = usuario.user?.id ?? null;
  const patch = { status: "cancelada", updated_by: userId };

  await tabela(supabase, "operational_expenses")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", membership.organizationId);

  revalidar();
}

async function removerRegistro(
  formData: FormData,
  nome: "operational_expenses" | "fiscal_entities" | "fiscal_entity_accounts",
): Promise<string | null> {
  const id = campoDe(formData)("id").trim();
  if (id === "") return "Não foi possível identificar o registro. Atualize a página para conferir.";

  const supabase = await createClient();
  const membership = await currentMembership(supabase);
  if (membership.organizationId === null) return "Sessão sem organização. Atualize a página.";

  const { data, error } = await tabela(supabase, nome)
    .delete()
    .eq("id", id)
    .eq("organization_id", membership.organizationId)
    .select("id");

  if (error !== null) return "Não foi possível confirmar a remoção. Confira os dados antes de tentar novamente.";
  if (!data?.length) return "Nada foi removido. Atualize a página para conferir o registro e seu acesso.";
  revalidar();
  return null;
}

export async function removerDespesa(formData: FormData): Promise<string | null> {
  return removerRegistro(formData, "operational_expenses");
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

export async function removerEntidadeFiscal(formData: FormData): Promise<string | null> {
  return removerRegistro(formData, "fiscal_entities");
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

export async function removerVinculoContaEntidade(formData: FormData): Promise<string | null> {
  return removerRegistro(formData, "fiscal_entity_accounts");
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

/**
 * Replica todas as despesas mensais ativas de um mês de origem para o mês
 * seguinte usando `idempotency_key` único por `(organização, competência,
 * categoria, nome)`: cliques repetidos nunca geram lançamentos duplicados.
 */
export async function gerarRecorrentesProximoMes(
  _anterior: ResultadoDoCadastro,
  formData: FormData,
): Promise<ResultadoDoCadastro> {
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

  if (membership.organizationId === null) {
    return { ...SEM_ERRO, mensagem: "Sessão sem organização — atualize a página." };
  }

  const mesOrigem = campoDe(formData)("source_month").trim();
  const inicioDestino = proximoMes(mesOrigem);

  if (inicioDestino === null) {
    return { ...SEM_ERRO, erros: { source_month: "Escolha o mês de origem para replicar as despesas recorrentes." } };
  }

  const inicioOrigem = `${mesOrigem}-01`;
  const [anoOrig, mesOrig] = mesOrigem.split("-").map(Number);
  const ultimoDiaOrigem = new Date(Date.UTC(anoOrig ?? 2026, mesOrig ?? 1, 0)).toISOString().slice(0, 10);

  const dbRead = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (k: string, v: string) => {
          eq: (k: string, v: string) => {
            neq: (k: string, v: string) => {
              gte: (k: string, v: string) => {
                lte: (k: string, v: string) => {
                  limit: (n: number) => Promise<{
                    data:
                      | readonly {
                          readonly name: string;
                          readonly category: string;
                          readonly cost_type: string;
                          readonly allocation_method: string;
                          readonly planned_amount: number | string;
                          readonly marketplace: string | null;
                          readonly cost_center: string | null;
                          readonly note: string | null;
                        }[]
                      | null;
                    error: DbErro | null;
                  }>;
                };
              };
            };
          };
        };
      };
    };
  };

  const { data: origens, error: readErr } = await dbRead
    .from("operational_expenses")
    .select("name, category, cost_type, allocation_method, planned_amount, marketplace, cost_center, note")
    .eq("organization_id", membership.organizationId)
    .eq("recurrence", "mensal")
    .neq("status", "cancelada")
    .gte("competence_date", inicioOrigem)
    .lte("competence_date", ultimoDiaOrigem)
    .limit(200);

  if (readErr !== null) return traduzirErro(readErr, "despesas recorrentes");
  if (origens === null || origens.length === 0) {
    return { ...SEM_ERRO, mensagem: `Nenhuma despesa mensal ativa encontrada em ${mesOrigem} para replicar.` };
  }

  const { data: usuario } = await supabase.auth.getUser();
  const userId = usuario.user?.id ?? null;
  const destinoYm = inicioDestino.slice(0, 7);

  let criadas = 0;
  let jaExistiam = 0;

  for (const item of origens) {
    const slug = item.name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);

    const idempotencyKey = `exp:${destinoYm}:${item.category}:${slug}`;
    const { error: insErr } = await tabela(supabase, "operational_expenses")
      .insert({
        organization_id: membership.organizationId,
        name: item.name,
        category: item.category,
        cost_type: item.cost_type,
        recurrence: "mensal",
        allocation_method: item.allocation_method,
        planned_amount: Number(item.planned_amount),
        actual_amount: null,
        competence_date: inicioDestino,
        status: "prevista",
        marketplace: item.marketplace ?? "TODOS",
        cost_center: item.cost_center,
        note: item.note,
        idempotency_key: idempotencyKey,
        created_by: userId,
        updated_by: userId,
      })
      .select("id");

    if (insErr === null) {
      criadas += 1;
    } else if (insErr.code === "23505") {
      jaExistiam += 1;
    } else {
      return traduzirErro(insErr, "despesas recorrentes");
    }
  }

  revalidar();

  return {
    ok: true,
    mensagem:
      criadas > 0
        ? `${String(criadas)} despesa(s) recorrente(s) gerada(s) para ${destinoYm}${jaExistiam > 0 ? ` (${String(jaExistiam)} já existiam — duplicidade evitada)` : ""}.`
        : `Todas as ${String(jaExistiam)} despesas recorrentes já existem em ${destinoYm} — nenhuma duplicidade criada.`,
    erros: {},
  };
}
