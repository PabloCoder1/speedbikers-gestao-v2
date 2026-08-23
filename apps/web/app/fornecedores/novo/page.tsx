import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../../components/shell";
import { SupplierForm } from "./supplier-form";

export const metadata = { title: "Novo fornecedor — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

export default function NovoFornecedorPage(): ReactNode {
  return (
    <Shell>
      <p style={{ margin: 0, fontSize: "0.875rem" }}>
        <Link href="/fornecedores">← Fornecedores</Link>
      </p>

      <h1 style={{ margin: "var(--sb-space-2) 0 var(--sb-space-4)", fontSize: "1.375rem" }}>Novo fornecedor</h1>

      <SupplierForm />
    </Shell>
  );
}
