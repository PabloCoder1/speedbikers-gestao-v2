import Link from "next/link";
import type { ReactNode } from "react";

import { AcessoRestrito } from "../../../components/acesso-restrito";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { UploadForm } from "./upload-form";
import { createClient } from "../../../lib/supabase/server";
import { currentMembership } from "../../../lib/membership";

export const metadata = { title: "Nova importação — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

export default async function NovaImportacaoPage(): Promise<ReactNode> {
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

/*
  RESTRITA A ADMIN (D-312). Importar uma planilha do UpSeller reescreve o
  catálogo, e o dono do produto decidiu que a porta é de quem administra a
  base — a tela saiu de "Operação" e foi para "Administração" no menu.

  A recusa é no SERVIDOR, e não só no menu escondido: quem tem o endereço
  chega aqui (D-295 §3). O que esta linha AINDA não é: a última defesa. As
  policies de `erp_import_batches`/`erp_import_rows` e as rotas da api
  continuam autorizando ADMIN **e GESTOR** — fechar isso é migration e está
  registrado como pendência.
*/
  if (membership.role !== "ADMIN") {
    return <AcessoRestrito titulo="Nova importação" />;
  }

  return (
    <Shell>
      <PageTitle
        eyebrow="ADMINISTRAÇÃO / DADOS E PROCESSAMENTOS"
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
