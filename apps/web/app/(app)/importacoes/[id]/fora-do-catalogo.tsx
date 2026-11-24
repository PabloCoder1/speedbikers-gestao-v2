import Link from "next/link";
import type { ReactNode } from "react";

import { Panel } from "../../../../components/panel";
import { formatCount, formatDateTime } from "../../../../lib/format";
import {
  novosAusentes,
  pareceExportacaoParcial,
  type PreviaForaDoCatalogo,
} from "../../../../lib/produtos-fora-do-catalogo";

/**
 * D-860 — os produtos da planilha anterior que NÃO vieram nesta.
 *
 * Só aparece na conferência de uma planilha de produtos. Mostra quantos
 * ficariam fora do catálogo e quantos destes ainda têm saldo, vínculo com
 * anúncio ou já estavam marcados -- para quem confirma decidir se a planilha
 * é o catálogo completo. A decisão em si (a caixa de marcar) fica na
 * confirmação, logo abaixo.
 */

function rotuloSaldo(saldo: number | null): string {
  // Sem linha de saldo não é zero (regra do projeto): é "—".
  return saldo === null ? "—" : formatCount(saldo);
}

export function ForaDoCatalogo({ previa }: { previa: PreviaForaDoCatalogo }): ReactNode {
  const novos = novosAusentes(previa);
  const parcial = pareceExportacaoParcial(previa);
  const restantes = previa.ausentes - previa.amostra.length;

  const subtitulo =
    previa.ausentes === 0
      ? "Todos os produtos das planilhas anteriores vieram nesta."
      : `${formatCount(previa.ausentes)} de ${formatCount(previa.conhecidos)} produtos das planilhas anteriores ${previa.ausentes === 1 ? "não veio" : "não vieram"} nesta.`;

  return (
    <div className="sb-import-fora">
      <Panel title="Produtos que não vieram nesta planilha" subtitle={subtitulo}>
        {previa.voltam > 0 && (
          <p className="sb-import-fora-nota">
            {formatCount(previa.voltam)}{" "}
            {previa.voltam === 1 ? "produto marcado como fora do catálogo volta" : "produtos marcados como fora do catálogo voltam"}{" "}
            nesta planilha e {previa.voltam === 1 ? "deixa de ser marcado" : "deixam de ser marcados"} ao aplicar.
          </p>
        )}

        {previa.ausentes > 0 && (
          <>
            <dl className="sb-fact-grid">
              <div>
                <dt>Ficariam fora agora</dt>
                <dd>{formatCount(novos)}</dd>
              </div>
              <div>
                <dt>Já estavam fora</dt>
                <dd>{formatCount(previa.jaMarcados)}</dd>
              </div>
              <div>
                <dt>Com saldo</dt>
                <dd>{formatCount(previa.comSaldo)}</dd>
              </div>
              <div>
                <dt>Com anúncio vinculado</dt>
                <dd>{formatCount(previa.comVinculo)}</dd>
              </div>
            </dl>

            {parcial && (
              <p role="alert" className="sb-import-fora-alerta">
                São mais de 10% do catálogo. Se esta exportação saiu com filtro ou só uma página, não marque: os
                produtos que existem ficariam inativos.
              </p>
            )}

            <p className="sb-import-fora-nota">
              Marcar não apaga nada: o produto fica inativo, sai da Reposição e mantém pedidos, vínculos e histórico.
              Se voltar numa planilha futura, a marca sai sozinha.
            </p>

            <div className="sb-import-fora-tabela">
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Produto</th>
                    <th className="sb-num">Saldo</th>
                    <th>Anúncio</th>
                    <th>Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {previa.amostra.map((item) => (
                    <tr key={item.skuId}>
                      <td className="sb-mono">
                        <Link prefetch={false} href={`/skus/${item.skuId}`}>{item.sku}</Link>
                      </td>
                      <td>{item.title ?? "—"}</td>
                      <td className="sb-num">{rotuloSaldo(item.saldo)}</td>
                      <td>{item.comVinculo ? "vinculado" : "—"}</td>
                      <td>{item.foraDesde === null ? "ativo" : `fora desde ${formatDateTime(item.foraDesde)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {restantes > 0 && (
              <p className="sb-import-fora-nota">
                Mostrando os {formatCount(previa.amostra.length)} primeiros por SKU; mais {formatCount(restantes)} não
                aparecem aqui.
              </p>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
