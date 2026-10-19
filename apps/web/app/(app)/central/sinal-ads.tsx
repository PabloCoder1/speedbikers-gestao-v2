import Link from "next/link";
import type { ReactNode } from "react";

import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../components/estado-da-tela";
import { Panel } from "../../../components/panel";
import { StatePill } from "../../../components/state-pill";
import { formatBusinessDate, formatCount } from "../../../lib/format";
import { lerCampanhaSinal, lerSinaisAds, NIVEL_ADS, paraRevisarAds } from "../../../lib/sinais-ads";
import { funcaoAusente, SendoAtivado, type RespostaComCodigo } from "./comum";

/**
 * Os sinais de Ads na central (D-398): quantas campanhas pedem revisão, quantas
 * têm espaço para escalar, e as três primeiras com o motivo mais direto. A
 * lista inteira e a tabela moram em `/central/ads`.
 *
 * Chega por streaming, como o painel de frete. A semana é a dos dias que o
 * Mercado Livre já consolidou, não o período escolhido na central — o painel
 * diz qual é.
 *
 * Falha, formato desconhecido e semana vazia falam pelo `EstadoDaTela` (D-502),
 * com as mesmas palavras de `/central/ads`; a função ausente, pelo aviso de
 * "sendo ativado" (UX_SYSTEM §6, bloco 4).
 */
export async function SinalDeAds({
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
      <Panel title="Ads" subtitle="Sinais das campanhas do Mercado Ads">
        <div className="sb-panel-body">
          {funcaoAusente(resposta.error) ? (
            <SendoAtivado>
              Os sinais de Ads estão sendo ativados neste ambiente: o banco ainda não recebeu a função de D-398. Assim que
              a migração for aplicada, este painel passa a mostrar as campanhas que pedem revisão.
            </SendoAtivado>
          ) : (
            <EstadoDaTela tipo="erro" titulo="Não foi possível carregar os sinais de Ads" detalhe={resposta.error.message} acao={tentar} />
          )}
        </div>
      </Panel>
    );
  }

  const sinais = lerSinaisAds(resposta.data);

  if (sinais === null) {
    return (
      <Panel title="Ads" subtitle="Sinais das campanhas do Mercado Ads">
        <div className="sb-panel-body">
          <EstadoDaTela
            tipo="erro"
            titulo="Os sinais de Ads responderam num formato que esta tela não reconhece"
            descricao="Nada foi mostrado."
            acao={tentar}
          />
        </div>
      </Panel>
    );
  }

  const { resumo, janela } = sinais;

  if (janela.inicio === null || janela.fim === null) {
    return (
      <Panel title="Ads" subtitle="Sinais das campanhas do Mercado Ads">
        <div className="sb-panel-body">
          <EstadoDaTela
            tipo="vazio"
            titulo="Nenhuma semana de Ads consolidada nos últimos 21 dias"
            descricao="Sem campanha com gasto e venda atribuída, não há o que comparar."
          />
        </div>
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
