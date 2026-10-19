import Link from "next/link";
import type { ReactNode } from "react";

import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../components/estado-da-tela";
import { Panel } from "../../../components/panel";
import { StatePill } from "../../../components/state-pill";
import { lerDetectorFrete, motivosDoAlerta, NIVEL, paraRevisar } from "../../../lib/detector-frete";
import { formatCount, formatCurrency } from "../../../lib/format";
import { funcaoAusente, SendoAtivado, type RespostaComCodigo } from "./comum";

/**
 * O detector de frete na central (D-397): quantos anúncios pedem revisão e os
 * três primeiros, com o motivo mais direto de cada um. A lista inteira mora em
 * `/central/frete`.
 *
 * Chega por streaming, depois dos indicadores: a RPC olha 90 dias de pedidos e
 * não pode segurar o resto da tela. É da organização inteira, sem o filtro de
 * conta da central — o painel diz isso.
 *
 * Falha e formato desconhecido falam pelo `EstadoDaTela` (D-502), com o
 * "Tentar de novo" no recorte da central; a função ausente, pelo aviso de
 * "sendo ativado" das outras telas (UX_SYSTEM §6, bloco 4).
 */
export async function SinalDoFrete({
  leitura,
  tentarDeNovo,
}: {
  leitura: PromiseLike<RespostaComCodigo> | null;
  /** A central no recorte atual: o "Tentar de novo" lê tudo outra vez, no lugar. */
  tentarDeNovo: string;
}): Promise<ReactNode> {
  if (leitura === null) return null;

  const resposta = await leitura;
  const tentar = { href: tentarDeNovo, rotulo: TENTAR_DE_NOVO, mesmaTela: true };

  if (resposta.error !== null) {
    return (
      <Panel title="Frete" subtitle="Detector de frete possivelmente errado">
        <div className="sb-panel-body">
          {funcaoAusente(resposta.error) ? (
            <SendoAtivado>
              O detector de frete está sendo ativado neste ambiente: o banco ainda não recebeu a função de D-397. Assim que
              a migração for aplicada, este painel passa a mostrar os anúncios que pedem revisão.
            </SendoAtivado>
          ) : (
            <EstadoDaTela
              tipo="erro"
              titulo="Não foi possível carregar o detector de frete"
              detalhe={resposta.error.message}
              acao={tentar}
            />
          )}
        </div>
      </Panel>
    );
  }

  const detector = lerDetectorFrete(resposta.data);

  if (detector === null) {
    return (
      <Panel title="Frete" subtitle="Detector de frete possivelmente errado">
        <div className="sb-panel-body">
          <EstadoDaTela
            tipo="erro"
            titulo="O detector respondeu num formato que esta tela não reconhece"
            descricao="Nada foi mostrado."
            acao={tentar}
          />
        </div>
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
