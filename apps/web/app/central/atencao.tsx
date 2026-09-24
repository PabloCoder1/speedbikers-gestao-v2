import Link from "next/link";
import type { ReactNode } from "react";

import { Panel } from "../../components/panel";
import { StatePill } from "../../components/state-pill";
import { TOM } from "../../components/tone";
import { lerVisaoAds } from "../../lib/ads";
import {
  contarPorSeveridade,
  montarAtencao,
  ORDEM_DAS_SEVERIDADES,
  rotuloDaContagem,
  SEVERIDADE,
} from "../../lib/central-atencao";
import { entradaDaCentral, montarIndicadores, type Indicador } from "../../lib/central-indicadores";
import { lerMetaDoMes } from "../../lib/central-meta";
import type { PeriodoCentral } from "../../lib/central-periodo";
import type { LimitesDaCentral } from "../../lib/limites-central";
import { lerDetectorFrete } from "../../lib/detector-frete";
import { lerFaturamento, type ProdutosDoFaturamento } from "../../lib/faturamento";
import { formatBusinessDate } from "../../lib/format";
import { lerSinaisAds } from "../../lib/sinais-ads";
import type { RespostaRpc } from "../faturamento/numeros";

interface RespostaComCodigo {
  data: unknown;
  error: { message: string; code?: string } | null;
}

type Leitura = PromiseLike<RespostaComCodigo> | null;

/**
 * "O que precisa da sua atenção" (D-400) — a central de alertas no topo da
 * Central do negócio. Espera as mesmas leituras que a página já disparou (os
 * indicadores, a meta, o detector de frete e os sinais de Ads) e mais uma: o
 * faturamento do período COM detalhe, que conta os produtos com margem
 * negativa. Chega por streaming, sem segurar os indicadores.
 *
 * Fonte que falhou não vira zero: ela sai da lista e o rodapé diz qual ficou de
 * fora. As regras de cada item estão em `lib/central-atencao.ts`.
 */
export async function Atencao({
  leituras,
  leituraMeta,
  leituraFrete,
  leituraAds,
  leituraProdutos,
  leituraLimites,
  periodo,
  hrefRanking,
}: {
  leituras: Promise<readonly [RespostaRpc, RespostaRpc, RespostaRpc, RespostaRpc]>;
  leituraMeta: Leitura;
  leituraFrete: Leitura;
  leituraAds: Leitura;
  leituraProdutos: PromiseLike<RespostaComCodigo>;
  leituraLimites: Promise<LimitesDaCentral>;
  periodo: PeriodoCentral;
  hrefRanking: string;
}): Promise<ReactNode> {
  const [
    [atualResult, anteriorResult, adsResult, adsAnteriorResult],
    respostaMeta,
    respostaFrete,
    respostaAds,
    respostaProdutos,
    limites,
  ] = await Promise.all([leituras, leituraMeta, leituraFrete, leituraAds, leituraProdutos, leituraLimites]);

  const faltam: string[] = [];

  const margem = margemDoPeriodo(atualResult, anteriorResult, adsResult, adsAnteriorResult, periodo, limites);

  if (margem === null) faltam.push("margem geral");

  const meta = ler(respostaMeta, lerMetaDoMes, "meta do mês", faltam);
  const detector = ler(respostaFrete, lerDetectorFrete, "detector de frete", faltam);
  const sinaisAds = ler(respostaAds, lerSinaisAds, "sinais de Ads", faltam);
  const produtos = ler(respostaProdutos, (dado): ProdutosDoFaturamento | null => lerFaturamento(dado)?.produtos ?? null, "produtos", faltam);

  const itens = montarAtencao({
    sinaisAds,
    detector,
    produtos,
    margem,
    meta,
    atrasoDaMeta: limites.atrasoDaMeta,
    periodo: textoDoPeriodo(periodo),
    hrefRanking,
  });
  const contagem = contarPorSeveridade(itens);

  return (
    <Panel
      title="O que precisa da sua atenção"
      subtitle="Margem, frete, Ads e meta, do mais grave para a oportunidade. Estoque, atendimento e a fila de ações da operação ficam na Visão Geral."
      aside={
        <Link className="sb-button" href="/">
          Visão Geral
        </Link>
      }
    >
      <div className="sb-panel-body">
        {itens.length === 0 ? (
          <p className="sb-meta-frase">
            Nada pede atenção agora nos sinais que a central acompanha: sem campanha crítica, sem produto com margem
            negativa, sem frete destoante e sem meta atrasada.
          </p>
        ) : (
          <>
            <p className="sb-atencao-contagem">
              {ORDEM_DAS_SEVERIDADES.filter((s) => contagem[s] > 0).map((s) => (
                <span key={s} className="sb-status" style={TOM[SEVERIDADE[s].tom]}>
                  {rotuloDaContagem(s, contagem[s])}
                </span>
              ))}
            </p>

            <ul className="sb-atencao-lista">
              {itens.map((item) => (
                <li key={`${item.severidade}:${item.categoria}:${item.href}`}>
                  <StatePill tone={{ tom: SEVERIDADE[item.severidade].tom, label: SEVERIDADE[item.severidade].rotulo }} />
                  <span className="sb-atencao-categoria">{item.categoria}</span>
                  <span className="sb-atencao-texto">{item.texto}</span>
                  <Link className="sb-atencao-link" href={item.href}>
                    ver
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}

        {faltam.length > 0 && (
          <p className="sb-central-motivo">
            Fora desta lista por não terem carregado ou ainda estarem sendo ativados: {faltam.join(", ")}.
          </p>
        )}
      </div>
    </Panel>
  );
}

/** Lê uma resposta com o leitor dela; falha, função ausente ou formato desconhecido vão para `faltam`. */
function ler<T>(
  resposta: RespostaComCodigo | null,
  leitor: (dado: unknown) => T | null,
  nome: string,
  faltam: string[],
): T | null {
  if (resposta?.error !== null) {
    faltam.push(nome);

    return null;
  }

  const lido = leitor(resposta.data);

  if (lido === null) faltam.push(nome);

  return lido;
}

/** O indicador de margem da central, pela mesma entrada e regra de comparação dos indicadores. */
function margemDoPeriodo(
  atualResult: RespostaRpc,
  anteriorResult: RespostaRpc,
  adsResult: RespostaRpc,
  adsAnteriorResult: RespostaRpc,
  periodo: PeriodoCentral,
  limites: LimitesDaCentral,
): Indicador | null {
  const atual = atualResult.error === null ? lerFaturamento(atualResult.data) : null;

  if (atual === null) return null;

  const anterior = anteriorResult.error === null ? lerFaturamento(anteriorResult.data) : null;
  const ads = adsResult.error === null ? lerVisaoAds(adsResult.data) : null;
  const adsAnterior = adsAnteriorResult.error === null ? lerVisaoAds(adsAnteriorResult.data) : null;
  const indicadores = montarIndicadores(entradaDaCentral(atual, anterior, ads, adsAnterior, periodo), limites);

  return indicadores.find((i) => i.id === "margem") ?? null;
}

function textoDoPeriodo(periodo: PeriodoCentral): string {
  const { from, to } = periodo.atual;

  return from === to ? `em ${formatBusinessDate(from)}` : `entre ${formatBusinessDate(from)} e ${formatBusinessDate(to)}`;
}
