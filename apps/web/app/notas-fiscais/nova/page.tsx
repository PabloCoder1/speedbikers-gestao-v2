import Link from "next/link";
import type { ReactNode } from "react";

import { PageTitle } from "../../../components/page-title";
import { Shell } from "../../../components/shell";
import { UploadForm } from "./upload-form";

export const metadata = { title: "Enviar NF-e — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

export default function NovaNotaFiscalPage(): ReactNode {
  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Upload XML"
        subtitle={<Link href="/notas-fiscais">← Voltar ao histórico de notas</Link>}
        compacto
      />

      <UploadForm />
    </Shell>
  );
}
