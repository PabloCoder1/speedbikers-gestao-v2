import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { AcessoRestrito } from "../../../../components/acesso-restrito";
import { PageTitle } from "../../../../components/page-title";
import { Shell } from "../../../../components/shell";
import { lerExistentes } from "../../../../lib/supplier-existentes";
import { currentMembership } from "../../../../lib/request-membership";
import { createClient } from "../../../../lib/supabase/server";
import { AlternarAtivo } from "../../alternar-ativo";
import { ExcluirFornecedor } from "../../excluir-fornecedor";
import { SupplierForm } from "../../novo/supplier-form";
import { Voltar } from "../../voltar";

export const metadata = { title: "Editar fornecedor — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Edição do fornecedor (D-366). `update_supplier` existia desde a Fase 4 sem
 * nenhuma tela: cadastro errado ficava errado.
 */
export default async function EditarFornecedorPage({
  params,
  searchParams,
}: {
  params: Promise<{ supplierId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { supplierId } = await params;
  const { aviso } = await searchParams;
  const membership = await currentMembership();

  if (membership.role !== "ADMIN" && membership.role !== "GESTOR") {
    return <AcessoRestrito titulo="Editar fornecedor" papel="ADMIN ou GESTOR" />;
  }

  const supabase = await createClient();
  // As duas leituras partem do id da URL e da sessão, e vão juntas (D-195).
  const [{ data, error }, existentes, logo, pedidos] = await Promise.all([
    supabase
      .from("suppliers")
      .select("id, name, legal_name, document, contact_name, email, phone, whatsapp, website, notes, is_active")
      .eq("id", supplierId)
      .maybeSingle(),
    lerExistentes(supabase),
    // A logo em leitura SEPARADA (D-370): onde a migration ainda não chegou, a
    // coluna não existe, e pedi-la junto derrubaria a edição inteira em 404.
    supabase.from("suppliers").select("logo_path").eq("id", supplierId).maybeSingle(),
    // Só a contagem, para o "Excluir" dizer antes de confirmar se dá (D-372).
    supabase.from("purchase_orders").select("id", { count: "exact", head: true }).eq("supplier_id", supplierId),
  ]);

  // Inexistente, de outra organização ou id malformado: os três viram 404.
  if (error !== null || data === null) {
    notFound();
  }

  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title={`Editar ${data.name}`}
        subtitle="Só o nome é obrigatório. A prévia mostra como o cadastro aparece na lista e nos pedidos."
        aside={
          <>
            <Voltar href={`/fornecedores/${data.id}`} rotulo="Voltar ao fornecedor" />
            <AlternarAtivo id={data.id} ativo={data.is_active} />
            <ExcluirFornecedor id={data.id} nome={data.name} pedidos={pedidos.error === null ? pedidos.count : null} />
          </>
        }
        compacto
      />

      {!data.is_active && (
        <p className="sb-note" style={{ margin: "0 0 var(--sb-space-3)" }}>
          Este fornecedor está <b>inativo</b>: não aparece na escolha de novos pedidos de compra. O histórico continua.
        </p>
      )}

      {aviso === "logo" && (
        <p role="alert" className="sb-note sb-note-atencao" style={{ margin: "0 0 var(--sb-space-3)" }}>
          O fornecedor foi salvo, mas a <b>logo não subiu</b>. Escolha a imagem de novo e salve.
        </p>
      )}

      <SupplierForm
        id={data.id}
        existentes={existentes}
        organizationId={membership.organizationId}
        logoPath={logo.error === null ? (logo.data?.logo_path ?? null) : null}
        inicial={{
          name: data.name,
          legalName: data.legal_name,
          document: data.document,
          contactName: data.contact_name,
          email: data.email,
          phone: data.phone,
          whatsapp: data.whatsapp,
          website: data.website,
          notes: data.notes,
        }}
      />
    </Shell>
  );
}
