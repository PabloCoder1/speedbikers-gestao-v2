import Link from "next/link";
import type { ReactNode } from "react";

import { Panel } from "../../components/panel";
import { StatePill } from "../../components/state-pill";
import { formatBusinessDate, formatCount } from "../../lib/format";
import { lerCampanhaSinal, lerSinaisAds, NIVEL_ADS, paraRevisarAds } from "../../lib/sinais-ads";

interface RespostaComCodigo {
  data: unknown;
  error: { message: string; code?: string } | null;
}

/**
 * Os sinais de Ads na central (D-398): quantas campanhas pedem revisão, quantas
 * têm espaço para escalar, e as três primeiras com o motivo mais direto. A
 * lista inteira e a tabela moram em `/central/ads`.
 *
 * Chega por streaming, como o painel de frete. A semana é a dos dias que o
 * Mercado Livre já consolidou, não o período escolhido na central — o painel
 * diz qual é.
 */
export async function SinalDeAds({ leitura }: { leitura: PromiseLike<RespostaComCodigo> | null }): Promise<ReactNode> {
  if (leitura === null) return null;

  const resposta = await leitura;

  if (resposta.error !== null) {
    return (
      <Panel title="Ads" subtitle="Sinais das campanhas do Mercado Ads">
        <p className="sb-panel-body sb-central-motivo">
          {resposta.error.code === "PGRST202"
            ? "Os sinais de Ads estão sendo ativados neste ambiente."
            : `Não foi possível carregar os sinais de Ads: ${resposta.error.message}`}
        </p>
      </Panel>
    );
  }

  const sinais = lerSinaisAds(resposta.data);

  if (sinais === null) {
    return (
      <Panel title="Ads" subtitle="Sinais das campanhas do Mercado Ads">
        <p className="sb-panel-body sb-central-motivo">
          Os sinais de Ads responderam num formato que esta tela não reconhece — nada foi mostrado.
        </p>
      </Panel>
    );
  }

  const { resumo, janela } = sinais;

  if (janela.inicio === null || janela.fim === null) {
    return (
      <Panel title="Ads" subtitle="Sinais das campanhas do Mercado Ads">
        <p className="sb-panel-body sb-central-motivo">Nenhuma semana de Ads consolidada nos últimos 21 dias.</p>
      </Panel>
    );
  }

  const revisar = paraRevisarAds(resumo);
  const primeiros = sinais.campanhas.filter((c) => c.nivel !== "normal" && c.nivel !== "pausada").slice(0, 3);

  return (
    <Panel
      title="Ads"
      subtitle={`Semana de ${formatBusinessDate(janela.inicio)} a ${formatBusinessDate(janela.fim)}, os dias que o Mercado Livre já consolidou, contra a anterior.`}
      aside={
        <Link className="sb-button" href="/central/ads">
          Abrir sinais de Ads
        </Link>
      }
    >
      <div className="sb-panel-body">
        <p className="sb-meta-frase">
          {revisar === 0 ? (
            <>Nenhuma campanha pede revisão</>
          ) : (
            <>
              <strong>{formatCount(revisar)}</strong> {revisar === 1 ? "campanha pede" : "campanhas pedem"} revisão (
              {formatCount(resumo.critico)} crítica{resumo.critico === 1 ? "" : "s"}, {formatCount(resumo.abaixo_meta)} com ROAS
              abaixo da meta, {formatCount(resumo.atencao)} em atenção)
            </>
          )}
          {resumo.escala > 0 && (
            <>
              {" "}
              e <strong>{formatCount(resumo.escala)}</strong> {resumo.escala === 1 ? "tem" : "têm"} espaço para escalar
            </>
          )}
          .
        </p>

        {primeiros.length > 0 && (
          <div className="sb-central-bloco">
            <ul className="sb-sinal-lista">
              {primeiros.map((c) => {
                const [motivo] = lerCampanhaSinal(c, sinais.referencias, null).motivos;

                return (
                  <li key={`${c.ml_account_id}:${String(c.campaign_id)}`} className="sb-sinal-alerta">
                    <div className="sb-sinal-cabeca">
                      <StatePill tone={{ tom: NIVEL_ADS[c.nivel].tom, label: NIVEL_ADS[c.nivel].rotulo }} />
                      <div className="sb-sinal-titulo">
                        <strong>{c.nome}</strong>
                        {motivo !== undefined && <span>{motivo}</span>}
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
