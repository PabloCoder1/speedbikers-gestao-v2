import type { ReactNode } from "react";

import { AcessoRestrito } from "../../../components/acesso-restrito";
import { PageTitle } from "../../../components/page-title";
import { Shell } from "../../../components/shell";
import { lerExistentes } from "../../../lib/supplier-existentes";
import { currentMembership } from "../../../lib/request-membership";
import { createClient } from "../../../lib/supabase/server";
import { Voltar } from "../voltar";
import { SupplierForm } from "./supplier-form";

export const metadata = { title: "Novo fornecedor — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

export default async function NovoFornecedorPage(): Promise<ReactNode> {
  const membership = await currentMembership();

  // O formulário inteiro para quem o banco vai recusar no fim seria trabalho
  // jogado fora. A defesa continua em `create_supplier` (D-366).
  if (membership.role !== "ADMIN" && membership.role !== "GESTOR") {
    return <AcessoRestrito titulo="Novo fornecedor" papel="ADMIN ou GESTOR" />;
  }

  const existentes = await lerExistentes(await createClient());

  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Novo fornecedor"
        subtitle="Só o nome é obrigatório. A prévia mostra, enquanto você digita, como ele vai aparecer na lista e nos pedidos."
        aside={<Voltar href="/fornecedores" rotulo="Fornecedores" />}
        compacto
      />

      <SupplierForm existentes={existentes} organizationId={membership.organizationId} />
    </Shell>
  );
}
