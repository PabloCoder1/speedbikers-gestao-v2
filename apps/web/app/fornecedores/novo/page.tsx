import Link from "next/link";
import type { ReactNode } from "react";

import { PageTitle } from "../../../components/page-title";
import { Shell } from "../../../components/shell";
import { SupplierForm } from "./supplier-form";

export const metadata = { title: "Novo fornecedor — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

export default function NovoFornecedorPage(): ReactNode {
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
