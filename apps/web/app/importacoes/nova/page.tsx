import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../../components/shell";
import { UploadForm } from "./upload-form";

export const metadata = { title: "Nova importação — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

export default function NovaImportacaoPage(): ReactNode {
  return (
    <Shell>
      <p style={{ margin: 0, fontSize: "0.875rem" }}>
        <Link href="/importacoes">← Importações</Link>
      </p>

      <h1 style={{ margin: "var(--sb-space-2) 0 var(--sb-space-4)", fontSize: "1.375rem" }}>
        Nova importação
      </h1>

      <UploadForm />
    </Shell>
  );
}
