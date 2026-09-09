import Link from "next/link";
import type { ReactNode } from "react";

import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { UploadForm } from "./upload-form";

export const metadata = { title: "Nova importação — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

export default function NovaImportacaoPage(): ReactNode {
  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Nova importação"
        subtitle={<Link href="/importacoes">← Voltar ao histórico de importações</Link>}
        compacto
      />

      <Panel
        title="Planilha do UpSeller"
        subtitle="Enviar não altera o catálogo — o arquivo é lido e o resultado fica em conferência."
      >
        <div className="sb-panel-body">
          <UploadForm />
        </div>
      </Panel>
    </Shell>
  );
}
