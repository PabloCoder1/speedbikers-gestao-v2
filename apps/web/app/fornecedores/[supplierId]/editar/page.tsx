import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { AcessoRestrito } from "../../../../components/acesso-restrito";
import { PageTitle } from "../../../../components/page-title";
import { Shell } from "../../../../components/shell";
import { lerExistentes } from "../../../../lib/supplier-existentes";
import { currentMembership } from "../../../../lib/request-membership";
import { createClient } from "../../../../lib/supabase/server";
import { AlternarAtivo } from "../../alternar-ativo";
import { SupplierForm } from "../../novo/supplier-form";

export const metadata = { title: "Editar fornecedor — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Edição do fornecedor (D-366). `update_supplier` existia desde a Fase 4 sem
 * nenhuma tela: cadastro errado ficava errado.
 */
export default async function EditarFornecedorPage({
  params,
}: {
  params: Promise<{ supplierId: string }>;
}): Promise<ReactNode> {
  const { supplierId } = await params;
  const membership = await currentMembership();

  if (membership.role !== "ADMIN" && membership.role !== "GESTOR") {
    return <AcessoRestrito titulo="Editar fornecedor" papel="ADMIN ou GESTOR" />;
  }

  const supabase = await createClient();
  // As duas leituras partem do id da URL e da sessão, e vão juntas (D-195).
  const [{ data, error }, existentes] = await Promise.all([
    supabase
      .from("suppliers")
      .select("id, name, legal_name, document, contact_name, email, phone, whatsapp, website, notes, is_active")
      .eq("id", supplierId)
      .maybeSingle(),
    lerExistentes(supabase),
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
        subtitle={<Link href={`/fornecedores/${data.id}`}>← Voltar ao fornecedor</Link>}
        aside={<AlternarAtivo id={data.id} ativo={data.is_active} />}
        compacto
      />

      {!data.is_active && (
        <p className="sb-note" style={{ margin: "0 0 var(--sb-space-3)" }}>
          Este fornecedor está <b>inativo</b>: não aparece na escolha de novos pedidos de compra. O histórico continua.
        </p>
      )}

      <SupplierForm
        id={data.id}
        existentes={existentes}
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
