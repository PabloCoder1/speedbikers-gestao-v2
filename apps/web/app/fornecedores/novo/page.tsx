import Link from "next/link";
import type { ReactNode } from "react";

import { AcessoRestrito } from "../../../components/acesso-restrito";
import { PageTitle } from "../../../components/page-title";
import { Shell } from "../../../components/shell";
import { currentMembership } from "../../../lib/request-membership";
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

  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Novo fornecedor"
        subtitle={<Link href="/fornecedores">← Voltar aos fornecedores</Link>}
        compacto
      />

      <SupplierForm />
    </Shell>
  );
}
