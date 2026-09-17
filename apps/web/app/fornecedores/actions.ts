"use server";

import { revalidatePath } from "next/cache";

import { LOGO_BUCKET } from "../../lib/logo-fornecedor-url";
import { currentMembership } from "../../lib/membership";
import { conferirCadastro, type CampoFornecedor } from "../../lib/supplier-form";
import { createClient } from "../../lib/supabase/server";

/**
 * Cadastro e edição de fornecedor (D-366).
 *
 * `update_supplier` existia desde a Fase 4 e nenhuma tela o chamava: um
 * fornecedor cadastrado com o telefone errado ficava errado, e "inativar" só
 * existia como filtro. As RPCs continuam as mesmas (`security definer`, papel
 * ADMIN/GESTOR conferido lá dentro); o que é novo é a conferência campo a
 * campo antes (`lib/supplier-form.ts`) e o erro dito na língua de quem cadastra.
 *
 * As ações de fornecedor de `app/compras/actions.ts` ficam onde estão: o
 * formulário de pedido não as usa, e a tela de fornecedores passa a usar estas.
 */

export interface ResultadoSalvar {
  ok: boolean;
  id?: string;
  mensagem: string | null;
  erros: Partial<Record<CampoFornecedor, string>>;
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Todo parâmetro opcional é OMITIDO quando nulo — o gerador de tipos não aceita `p_x: null`. */
function omitir<T extends string>(chave: T, valor: string | null): Record<T, string> | Record<string, never> {
  return valor === null ? {} : ({ [chave]: valor } as Record<T, string>);
}

function traduzirErro(error: { code?: string; message: string }): Pick<ResultadoSalvar, "mensagem" | "erros"> {
  // `suppliers_org_name_unique`: o nome é único na organização.
  if (error.code === "23505") {
    return {
      mensagem: null,
      erros: { name: "Já existe um fornecedor com este nome." },
    };
  }

  if (error.message.includes("sem permissao")) {
    return {
      mensagem: "Só ADMIN e GESTOR podem cadastrar ou editar fornecedores.",
      erros: {},
    };
  }

  if (error.message.includes("nao encontrado")) {
    return {
      mensagem: "Fornecedor não encontrado — ele pode ter sido removido.",
      erros: {},
    };
  }

  return {
    mensagem: "Não foi possível salvar o fornecedor. Tente de novo.",
    erros: {},
  };
}

function lerFormulario(formData: FormData): Partial<Record<CampoFornecedor, unknown>> {
  return {
    name: formData.get("name"),
    legalName: formData.get("legalName"),
    document: formData.get("document"),
    contactName: formData.get("contactName"),
    email: formData.get("email"),
    phone: formData.get("phone"),
    whatsapp: formData.get("whatsapp"),
    website: formData.get("website"),
    notes: formData.get("notes"),
  };
}

async function lerAtual(supabase: Supabase, id: string) {
  return supabase
    .from("suppliers")
    .select("id, name, legal_name, document, contact_name, email, phone, whatsapp, website, notes, is_active")
    .eq("id", id)
    .maybeSingle();
}

function revalidar(id: string | null): void {
  revalidatePath("/fornecedores");
  // O formulário de pedido lista os fornecedores ATIVOS.
  revalidatePath("/compras/novo");
  if (id !== null) revalidatePath(`/fornecedores/${id}`);
}

/** Cria (`id` nulo) ou edita. O estado ativo não muda aqui — ele tem ação própria. */
export async function salvarFornecedor(id: string | null, formData: FormData): Promise<ResultadoSalvar> {
  const supabase = await createClient();

  const atual = id === null ? null : await lerAtual(supabase, id);

  if (atual !== null && (atual.error !== null || atual.data === null)) {
    return {
      ok: false,
      mensagem: "Fornecedor não encontrado nesta organização.",
      erros: {},
    };
  }

  const conferido = conferirCadastro(lerFormulario(formData), {
    documentoAnterior: atual?.data?.document ?? null,
  });

  if (!conferido.ok) {
    return { ok: false, mensagem: null, erros: conferido.erros };
  }

  const c = conferido.cadastro;
  const opcionais = {
    ...omitir("p_legal_name", c.legalName),
    ...omitir("p_document", c.document),
    ...omitir("p_contact_name", c.contactName),
    ...omitir("p_email", c.email),
    ...omitir("p_phone", c.phone),
    ...omitir("p_whatsapp", c.whatsapp),
    ...omitir("p_website", c.website),
    ...omitir("p_notes", c.notes),
  };

  if (atual?.data) {
    const { error } = await supabase.rpc("update_supplier", {
      p_id: atual.data.id,
      p_name: c.name,
      p_is_active: atual.data.is_active,
      ...opcionais,
    });

    if (error !== null) return { ok: false, ...traduzirErro(error) };

    revalidar(atual.data.id);

    return { ok: true, id: atual.data.id, mensagem: null, erros: {} };
  }

  const membership = await currentMembership(supabase);

  if (membership.error !== null) {
    return {
      ok: false,
      mensagem: "Não foi possível confirmar sua organização — tente de novo.",
      erros: {},
    };
  }

  if (membership.organizationId === null) {
    return {
      ok: false,
      mensagem: "Sua conta não está associada a nenhuma organização.",
      erros: {},
    };
  }

  const { data, error } = await supabase.rpc("create_supplier", {
    p_organization_id: membership.organizationId,
    p_name: c.name,
    ...opcionais,
  });

  if (error !== null) return { ok: false, ...traduzirErro(error) };

  revalidar(data.id);

  return { ok: true, id: data.id, mensagem: null, erros: {} };
}

/**
 * Ativar ou inativar. `update_supplier` sobrescreve o cadastro inteiro, então a
 * ação relê a linha e devolve cada campo como estava — só `is_active` muda.
 * Inativo sai da lista do pedido de compra; o histórico fica.
 */
/**
 * Exclui um fornecedor SEM pedido de compra (D-372). O banco decide
 * (`delete_supplier`): papel na organização e nenhum pedido. A logo, se havia,
 * sai do bucket DEPOIS de o cadastro sumir — se esse passo falhar, sobra um
 * arquivo órfão, que é o defeito barato.
 */
export async function excluirFornecedor(id: string): Promise<{ ok: boolean; mensagem: string | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delete_supplier", { p_id: id });

  if (error !== null) {
    const pedidos = /tem (\d+) pedido/.exec(error.message)?.[1];

    if (pedidos !== undefined) {
      return {
        ok: false,
        mensagem: `Não dá para excluir: ${pedidos === "1" ? "há 1 pedido de compra" : `há ${pedidos} pedidos de compra`} com este fornecedor. Inative-o — ele sai de novos pedidos e o histórico fica.`,
      };
    }

    if (error.message.includes("sem permissao")) {
      return { ok: false, mensagem: "Só ADMIN e GESTOR podem excluir fornecedores." };
    }

    if (error.message.includes("nao encontrado")) {
      return { ok: false, mensagem: "Fornecedor não encontrado — ele pode já ter sido excluído." };
    }

    return { ok: false, mensagem: "Não foi possível excluir o fornecedor. Tente de novo." };
  }

  if (data !== null) {
    await supabase.storage.from(LOGO_BUCKET).remove([data]);
  }

  revalidar(null);

  return { ok: true, mensagem: null };
}

export async function definirAtivo(id: string, ativo: boolean): Promise<{ ok: boolean; mensagem: string | null }> {
  const supabase = await createClient();
  const atual = await lerAtual(supabase, id);

  if (atual.error !== null || atual.data === null) {
    return {
      ok: false,
      mensagem: "Fornecedor não encontrado nesta organização.",
    };
  }

  const s = atual.data;
  const { error } = await supabase.rpc("update_supplier", {
    p_id: s.id,
    p_name: s.name,
    p_is_active: ativo,
    ...omitir("p_legal_name", s.legal_name),
    ...omitir("p_document", s.document),
    ...omitir("p_contact_name", s.contact_name),
    ...omitir("p_email", s.email),
    ...omitir("p_phone", s.phone),
    ...omitir("p_whatsapp", s.whatsapp),
    ...omitir("p_website", s.website),
    ...omitir("p_notes", s.notes),
  });

  if (error !== null) return { ok: false, mensagem: traduzirErro(error).mensagem };

  revalidar(s.id);

  return { ok: true, mensagem: null };
}
