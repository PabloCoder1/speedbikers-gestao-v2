import Link from "next/link";
import type { ReactNode } from "react";

import { Panel } from "../../components/panel";
import { StatePill } from "../../components/state-pill";
import { lerDetectorFrete, motivosDoAlerta, NIVEL, paraRevisar } from "../../lib/detector-frete";
import { formatCount, formatCurrency } from "../../lib/format";

interface RespostaComCodigo {
  data: unknown;
  error: { message: string; code?: string } | null;
}

/**
 * O detector de frete na central (D-397): quantos anúncios pedem revisão e os
 * três primeiros, com o motivo mais direto de cada um. A lista inteira mora em
 * `/central/frete`.
 *
 * Chega por streaming, depois dos indicadores: a RPC olha 90 dias de pedidos e
 * não pode segurar o resto da tela. É da organização inteira, sem o filtro de
 * conta da central — o painel diz isso.
 */
export async function SinalDoFrete({ leitura }: { leitura: PromiseLike<RespostaComCodigo> | null }): Promise<ReactNode> {
  if (leitura === null) return null;

  const resposta = await leitura;

  if (resposta.error !== null) {
    // Função ausente (PGRST202): a migration ainda não chegou a este banco.
    return (
      <Panel title="Frete" subtitle="Detector de frete possivelmente errado">
        <p className="sb-panel-body sb-central-motivo">
          {resposta.error.code === "PGRST202"
            ? "O detector de frete está sendo ativado neste ambiente."
            : `Não foi possível carregar o detector de frete: ${resposta.error.message}`}
        </p>
      </Panel>
    );
  }

  const detector = lerDetectorFrete(resposta.data);

  if (detector === null) {
    return (
      <Panel title="Frete" subtitle="Detector de frete possivelmente errado">
        <p className="sb-panel-body sb-central-motivo">O detector respondeu num formato que esta tela não reconhece — nada foi mostrado.</p>
      </Panel>
    );
  }

  const { resumo, janela } = detector;
  const revisar = paraRevisar(resumo);
  const primeiros = detector.alertas.filter((a) => a.nivel === "forte" || a.nivel === "provavel").slice(0, 3);

  return (
    <Panel
      title="Frete"
      subtitle="Últimos 14 dias, todas as contas: frete que destoa do histórico, do mesmo produto, da categoria ou do preço."
      aside={
        <Link className="sb-button" href="/central/frete">
          Abrir o detector
        </Link>
      }
    >
      <div className="sb-panel-body">
        <p className="sb-meta-frase">
          {revisar === 0 ? (
            <>Nenhum anúncio com problema provável de frete</>
          ) : (
            <>
              <strong>{formatCount(revisar)}</strong> {revisar === 1 ? "anúncio pede" : "anúncios pedem"} revisão de frete
              ({formatCount(resumo.forte)} com forte indício, {formatCount(resumo.provavel)} com provável problema)
            </>
          )}
          {resumo.atencao > 0 && <>, e {formatCount(resumo.atencao)} em atenção</>}.
          {resumo.excesso_14_dias !== null && resumo.excesso_14_dias > 0 && (
            <> Nos que pedem revisão, cerca de {formatCurrency(resumo.excesso_14_dias)} de frete a mais em 14 dias.</>
          )}
        </p>

        {primeiros.length > 0 && (
          <div className="sb-central-bloco">
            <ul className="sb-sinal-lista">
              {primeiros.map((a) => {
                const [motivo] = motivosDoAlerta(a, janela);

                return (
                  <li key={`${a.anuncio}:${a.faixa}`} className="sb-sinal-alerta">
                    <div className="sb-sinal-cabeca">
                      <StatePill tone={{ tom: NIVEL[a.nivel].tom, label: NIVEL[a.nivel].rotulo }} />
                      <div className="sb-sinal-titulo">
                        <strong>{a.titulo}</strong>
                        {motivo !== undefined && <span>{motivo.texto}</span>}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}
