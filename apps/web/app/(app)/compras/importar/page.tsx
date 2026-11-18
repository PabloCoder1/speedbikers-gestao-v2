import Link from "next/link";
import type { ReactNode } from "react";

import { EstadoDaTela } from "../../../../components/estado-da-tela";
import { PageTitle } from "../../../../components/page-title";
import { Panel } from "../../../../components/panel";
import { Voltar } from "../../../../components/voltar";
import { formatCount, formatDateTime } from "../../../../lib/format";
import { podeOperarCompras } from "../../../../lib/purchase-order-permission";
import { currentMembership } from "../../../../lib/request-membership";
import { createClient } from "../../../../lib/supabase/server";
import { ImportarPlanilha } from "./importar-planilha";

export const metadata = { title: "Importar pedidos anteriores — Speed Bikers Gestão" };
export const dynamic = "force-dynamic";

/**
 * Importar pedidos anteriores (D-764): as compras negociadas antes do sistema,
 * a partir das planilhas de controle. Etapa A (aqui): ler o arquivo NO
 * NAVEGADOR e classificar as colunas. As etapas B a E (vínculo, conferência e
 * gravação) acontecem no lote, em `/compras/importar/[loteId]`.
 */

interface LoteResumo {
  id: string;
  fileName: string;
  rowCount: number;
  createdAt: string;
  registradas: number;
  pendentes: number;
}

export default async function ImportarPedidosPage(): Promise<ReactNode> {
  const membership = await currentMembership();

  if (membership.organizationId === null || !podeOperarCompras(membership.role)) {
    return (
      <>
        <PageTitle eyebrow="ESTOQUE / OPERAÇÃO" title="Importar pedidos anteriores" aside={<Voltar href="/compras" rotulo="Pedidos de compra" />} />
        <EstadoDaTela
          tipo="vazio"
          titulo="Só ADMIN e GESTOR importam pedidos de compra"
          descricao="A importação registra compras e mexe no que a reposição considera encomendado."
        />
      </>
    );
  }

  const supabase = await createClient();
  const lotes = await supabase.rpc("get_purchase_import_batches", { p_organization_id: membership.organizationId });
  const lista = (lotes.error === null && Array.isArray(lotes.data) ? lotes.data : []) as unknown as LoteResumo[];

  return (
    <>
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Importar pedidos anteriores"
        subtitle="Compras feitas antes do sistema, a partir das planilhas de controle. Nada vira pedido sem a sua conferência: código ambíguo não vincula sozinho e quantidade como “200 + 200” espera confirmação."
        aside={<Voltar href="/compras" rotulo="Pedidos de compra" />}
      />

      <ImportarPlanilha />

      {lista.length > 0 && (
        <Panel title="Importações anteriores" subtitle="O mesmo arquivo importado de novo volta para o mesmo lote: nada é duplicado.">
          <table className="sb-table">
            <thead>
              <tr>
                <th>Arquivo</th>
                <th>Importado em</th>
                <th className="sb-num">Quantidades</th>
                <th className="sb-num">Registradas</th>
                <th className="sb-num">A conferir</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((l) => (
                <tr key={l.id}>
                  <td>
                    <Link href={`/compras/importar/${l.id}`}>{l.fileName}</Link>
                  </td>
                  <td>{formatDateTime(l.createdAt)}</td>
                  <td className="sb-num">{formatCount(l.rowCount)}</td>
                  <td className="sb-num">{formatCount(l.registradas)}</td>
                  <td className="sb-num">{formatCount(l.pendentes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  );
}
