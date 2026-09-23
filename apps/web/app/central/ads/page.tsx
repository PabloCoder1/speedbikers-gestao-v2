import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { CarregandoConteudo } from "../../../components/carregando";
import { FilterPill } from "../../../components/filter-pill";
import { KpiStrip, type KpiCellData } from "../../../components/kpi-strip";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { StatePill } from "../../../components/state-pill";
import { formatRoas, listarDatas } from "../../../lib/central-indicadores";
import { lerFaturamento } from "../../../lib/faturamento";
import { formatBusinessDate, formatCount, formatCurrency, formatPercent } from "../../../lib/format";
import { currentMembership } from "../../../lib/request-membership";
import {
  estimar,
  lerCampanhaSinal,
  lerSinaisAds,
  NIVEIS_COM_SINAL,
  NIVEL_ADS,
  roasDeEquilibrio,
  type CampanhaSinal,
  type NivelAds,
  type SinaisAds,
} from "../../../lib/sinais-ads";
import { createClient } from "../../../lib/supabase/server";
import { AVISO } from "../../faturamento/numeros";

export const metadata = { title: "Sinais de Ads — Speed Bikers Gestão" };

// Sessão por cookie e RLS por quem está logado: nada aqui pode ser pré-renderizado.
export const dynamic = "force-dynamic";

/**
 * Sinais de Ads (D-398) — as campanhas do Mercado Ads que pedem atenção ou têm
 * espaço para crescer, com o que aconteceu, a possível interpretação e o que
 * vale revisar; e a tabela de todas as campanhas da semana.
 *
 * **Duas leituras em sequência.** `get_sinais_ads` decide a semana (os 7 dias
 * que o Mercado Livre já consolidou) e os níveis; `get_faturamento` dessa mesma
 * semana dá a margem média da empresa, que entra como PREMISSA no lucro
 * estimado — a API de Product Ads não diz que produtos cada campanha vendeu.
 */

type Consulta = Record<string, string | string[] | undefined>;

function nivelDaUrl(query: Consulta): NivelAds | null {
  const valor = typeof query.nivel === "string" ? query.nivel : null;

  return NIVEIS_COM_SINAL.find((n) => n === valor) ?? null;
}

function hrefDoNivel(nivel: NivelAds | null): string {
  return nivel === null ? "/central/ads" : `/central/ads?nivel=${nivel}`;
}

export default function SinaisDeAdsPage(props: { searchParams: Promise<Consulta> }): ReactNode {
  return (
    <Shell>
      <Suspense fallback={<CarregandoConteudo rotulo="Carregando os sinais de Ads" />}>
        <SinaisContent {...props} />
      </Suspense>
    </Shell>
  );
}

function Titulo({ subtitle }: { subtitle: ReactNode }): ReactNode {
  return (
    <PageTitle
      eyebrow="COMERCIAL / CENTRAL"
      title="Sinais de Ads"
      subtitle={subtitle}
      aside={
        <>
          <Link className="sb-button" href="/faturamento#ads">
            Campanhas no faturamento
          </Link>
          <Link className="sb-button" href="/central">
            Voltar à central
          </Link>
        </>
      }
    />
  );
}

const SUBTITULO_PADRAO = "Campanhas do Mercado Ads que pedem atenção ou têm espaço para crescer.";

/** A margem média da empresa na semana: a após imposto quando há alíquota, senão a da venda. */
interface MargemDaSemana {
  readonly valor: number | null;
  readonly rotulo: string;
}

async function SinaisContent({ searchParams }: { searchParams: Promise<Consulta> }): Promise<ReactNode> {
  const query = await searchParams;
  const nivel = nivelDaUrl(query);
  const membership = await currentMembership();

  if (membership.organizationId === null) {
    return (
      <>
        <Titulo subtitle={SUBTITULO_PADRAO} />
        <p className="sb-empty">Sua conta não está associada a nenhuma organização.</p>
      </>
    );
  }

  const supabase = await createClient();
  const resposta = await supabase.rpc("get_sinais_ads", { p_organization_id: membership.organizationId });

  // Função ausente (PGRST202): a web da `main` chega à produção antes de a
  // migration passar pelo workflow — o precedente de D-363.
  if (resposta.error !== null) {
    return (
      <>
        <Titulo subtitle={SUBTITULO_PADRAO} />
        {resposta.error.code === "PGRST202" ? (
          <div className="sb-note">
            <span>SENDO ATIVADO</span>
            <p>
              Os sinais de Ads estão sendo ativados neste ambiente: o banco ainda não recebeu a função de D-398. Assim
              que a migração for aplicada, esta tela passa a listar as campanhas.
            </p>
          </div>
        ) : (
          <p role="alert" style={AVISO}>
            Não foi possível carregar os sinais de Ads: {resposta.error.message}
          </p>
        )}
      </>
    );
  }

  const sinais = lerSinaisAds(resposta.data);

  if (sinais === null) {
    return (
      <>
        <Titulo subtitle={SUBTITULO_PADRAO} />
        <p role="alert" style={AVISO}>
          Os sinais de Ads responderam num formato que esta tela não reconhece — nada foi mostrado.
        </p>
      </>
    );
  }

  const { janela } = sinais;

  if (janela.inicio === null || janela.fim === null) {
    return (
      <>
        <Titulo subtitle={SUBTITULO_PADRAO} />
        <p className="sb-empty">
          Nenhuma semana de Ads consolidada nos últimos 21 dias: sem campanha com gasto e venda atribuída, não há o que
          comparar.
        </p>
      </>
    );
  }

  const margem = await margemDaSemana(supabase, janela.inicio, janela.fim);
  const comSinal = sinais.campanhas.filter((c) => (NIVEIS_COM_SINAL as readonly string[]).includes(c.nivel));
  const lista = nivel === null ? comSinal : comSinal.filter((c) => c.nivel === nivel);

  return (
    <>
      <Titulo
        subtitle={
          <>
            Semana de {formatBusinessDate(janela.inicio)} a {formatBusinessDate(janela.fim)} contra{" "}
            {janela.anterior_inicio === null ? "a anterior" : formatBusinessDate(janela.anterior_inicio)} a{" "}
            {janela.anterior_fim === null ? "" : formatBusinessDate(janela.anterior_fim)}. Todas as contas.
            {janela.dias_pendentes.length > 0 &&
              ` Vendas com Ads de ${listarDatas(janela.dias_pendentes)} ainda não consolidadas pelo Mercado Livre — ficam de fora.`}
          </>
        }
      />

      <KpiStrip cells={celulasDoResumo(sinais, margem)} />

      <Panel
        title="Campanhas com sinal"
        subtitle={
          nivel === null
            ? "Da mais grave para a oportunidade; dentro do nível, a que mais investiu primeiro."
            : `Só ${NIVEL_ADS[nivel].rotulo.toLowerCase()}.`
        }
      >
        <div className="sb-panel-body">
          <div className="sb-sinal-filtros">
            <FilterPill href={hrefDoNivel(null)} active={nivel === null}>
              Todas ({formatCount(comSinal.length)})
            </FilterPill>
            {NIVEIS_COM_SINAL.map((n) => (
              <FilterPill key={n} href={hrefDoNivel(n)} active={nivel === n}>
                {NIVEL_ADS[n].rotulo} ({formatCount(contagem(sinais, n))})
              </FilterPill>
            ))}
          </div>

          {lista.length === 0 ? (
            <p className="sb-empty">
              {nivel === null
                ? "Nenhuma campanha com sinal nesta semana: todas perto da meta, sem gasto sem venda e sem espaço claro para escalar."
                : "Nenhuma campanha neste nível."}
            </p>
          ) : (
            <ol className="sb-sinal-lista">
              {lista.map((c) => (
                <CartaoDaCampanha key={`${c.ml_account_id}:${String(c.campaign_id)}`} campanha={c} sinais={sinais} margem={margem} />
              ))}
            </ol>
          )}
        </div>
      </Panel>

      <TabelaDeCampanhas sinais={sinais} margem={margem} />

      <ComoDecide sinais={sinais} margem={margem} />
    </>
  );
}

async function margemDaSemana(
  supabase: Awaited<ReturnType<typeof createClient>>,
  inicio: string,
  fim: string,
): Promise<MargemDaSemana> {
  const resposta = await supabase.rpc("get_faturamento", { p_date_from: inicio, p_date_to: fim, p_detalhe: false });
  const faturamento = resposta.error === null ? lerFaturamento(resposta.data) : null;

  if (faturamento === null) return { valor: null, rotulo: "margem da semana indisponível" };

  const aposImposto = faturamento.imposto?.margem_apos_imposto ?? null;

  if (aposImposto !== null) return { valor: aposImposto, rotulo: "margem média após imposto" };

  const venda = faturamento.resumo.margem_venda;

  return venda === null
    ? { valor: null, rotulo: "sem margem conhecida na semana" }
    : { valor: venda, rotulo: "margem média da venda (sem alíquota de imposto)" };
}

function contagem(s: SinaisAds, n: NivelAds): number {
  switch (n) {
    case "critico":
      return s.resumo.critico;
    case "abaixo_meta":
      return s.resumo.abaixo_meta;
    case "atencao":
      return s.resumo.atencao;
    case "escala":
      return s.resumo.escala;
    case "normal":
      return s.resumo.normal;
    case "pausada":
      return s.resumo.pausada;
  }
}

function celulasDoResumo(s: SinaisAds, margem: MargemDaSemana): KpiCellData[] {
  const r = s.resumo;
  const equilibrio = roasDeEquilibrio(margem.valor);
  const lucro = margem.valor === null ? null : r.receita_ads * margem.valor - r.investimento;

  return [
    {
      metricId: "nivel_sinal_ads",
      label: NIVEL_ADS.critico.rotulo,
      formula: "gasto sem venda (≥ R$ 50 e ≥ o orçamento diário) ou ROAS abaixo de 1",
      value: formatCount(r.critico),
      previous: null,
      href: hrefDoNivel("critico"),
      tom: NIVEL_ADS.critico.tom,
      ...(r.critico > 0 ? { destaque: NIVEL_ADS.critico.tom } : {}),
    },
    {
      metricId: "nivel_sinal_ads",
      label: NIVEL_ADS.abaixo_meta.rotulo,
      formula: "ROAS abaixo de 80% da meta configurada na campanha",
      value: formatCount(r.abaixo_meta),
      previous: null,
      href: hrefDoNivel("abaixo_meta"),
      tom: NIVEL_ADS.abaixo_meta.tom,
      ...(r.abaixo_meta > 0 ? { destaque: NIVEL_ADS.abaixo_meta.tom } : {}),
    },
    {
      metricId: "nivel_sinal_ads",
      label: NIVEL_ADS.atencao.rotulo,
      formula: "CPC +20% com conversão −15%, ou gasto +20% com ROAS −15%, contra a semana anterior",
      value: formatCount(r.atencao),
      previous: null,
      href: hrefDoNivel("atencao"),
      tom: NIVEL_ADS.atencao.tom,
    },
    {
      metricId: "nivel_sinal_ads",
      label: NIVEL_ADS.escala.rotulo,
      formula: "ativa, ROAS na meta, orçamento no teto (≥ 90% em média ou 4 de 7 dias) e 5 unidades ou mais",
      value: formatCount(r.escala),
      previous: null,
      href: hrefDoNivel("escala"),
      tom: NIVEL_ADS.escala.tom,
    },
    {
      metricId: "roas",
      label: "ROAS da semana",
      formula: "vendas com Ads ÷ investimento, dias consolidados",
      value: formatRoas(r.roas),
      previous: formatRoas(r.roas_anterior),
      ressalva:
        equilibrio === null
          ? `${formatCurrency(r.investimento)} investidos`
          : `${formatCurrency(r.investimento)} investidos · equilíbrio ${formatRoas(equilibrio)}`,
    },
    {
      metricId: "lucro_estimado_apos_ads",
      label: "Lucro estimado após Ads",
      formula: "vendas com Ads × margem média da empresa − investimento",
      value: lucro === null ? "—" : formatCurrency(lucro),
      previous: null,
      ressalva: margem.valor === null ? margem.rotulo : `${margem.rotulo}: ${formatPercent(margem.valor)}`,
    },
  ];
}

function CartaoDaCampanha({
  campanha: c,
  sinais,
  margem,
}: {
  campanha: CampanhaSinal;
  sinais: SinaisAds;
  margem: MargemDaSemana;
}): ReactNode {
  const nivel = NIVEL_ADS[c.nivel];
  const leitura = lerCampanhaSinal(c, sinais.referencias, margem.valor);
  const { lucro } = estimar(c, margem.valor);

  return (
    <li className="sb-sinal-alerta">
      <div className="sb-sinal-cabeca">
        <StatePill tone={{ tom: nivel.tom, label: nivel.rotulo }} />
        <div className="sb-sinal-titulo">
          <strong>{c.nome}</strong>
          <span>
            {c.conta} · orçamento {formatCurrency(c.orcamento)} por dia · meta de ROAS {formatRoas(c.roas_alvo)}
          </span>
        </div>
      </div>

      <dl className="sb-sinal-numeros">
        <div>
          <dt>Investimento</dt>
          <dd>
            {formatCurrency(c.investimento)} <small>antes {formatCurrency(c.investimento_anterior)}</small>
          </dd>
        </div>
        <div>
          <dt>Vendas com Ads</dt>
          <dd>
            {formatCurrency(c.receita_ads)} <small>{formatCount(c.unidades)} un.</small>
          </dd>
        </div>
        <div>
          <dt>ROAS</dt>
          <dd>
            {formatRoas(c.roas)} <small>antes {formatRoas(c.roas_anterior)}</small>
          </dd>
        </div>
        <div>
          <dt>CPC</dt>
          <dd>
            {formatCurrency(c.cpc)} <small>antes {formatCurrency(c.cpc_anterior)}</small>
          </dd>
        </div>
        <div>
          <dt>CTR</dt>
          <dd>{formatPercent(c.ctr)}</dd>
        </div>
        <div>
          <dt>Conversão</dt>
          <dd>
            {formatPercent(c.conversao)} <small>dos cliques</small>
          </dd>
        </div>
        <div>
          <dt>Orçamento</dt>
          <dd>
            {formatPercent(c.uso_orcamento)} <small>{c.dias_no_teto} de 7 dias no teto</small>
          </dd>
        </div>
        <div>
          <dt>Lucro estimado</dt>
          <dd>{formatCurrency(lucro)}</dd>
        </div>
      </dl>

      <details className="sb-sinal-porque">
        <summary>Por que o sistema apontou</summary>
        <ul>
          {leitura.motivos.map((m) => (
            <li key={m}>
              <span>{m}</span>
            </li>
          ))}
        </ul>
        {leitura.interpretacao !== null && (
          <p className="sb-sinal-interpretacao">
            <strong>Possível interpretação:</strong> {leitura.interpretacao}
          </p>
        )}
        <p className="sb-sinal-sugestao">{leitura.sugestao}</p>
      </details>
    </li>
  );
}

function TabelaDeCampanhas({ sinais, margem }: { sinais: SinaisAds; margem: MargemDaSemana }): ReactNode {
  return (
    <Panel
      title="Todas as campanhas da semana"
      subtitle="Com gasto nesta semana ou na anterior. Lucro estimado pela margem média da empresa — premissa, não medida por campanha."
    >
      <div className="sb-panel-body sb-central-tabela">
        <table className="sb-table sb-ads-tabela">
          <thead>
            <tr>
              <th>Campanha</th>
              <th>Sinal</th>
              <th className="sb-num">Investimento</th>
              <th className="sb-num">Vendas</th>
              <th className="sb-num">Unid.</th>
              <th className="sb-num">ROAS / meta</th>
              <th className="sb-num">ACOS</th>
              <th className="sb-num">CPC</th>
              <th className="sb-num">CTR</th>
              <th className="sb-num">Conversão</th>
              <th className="sb-num">CPA</th>
              <th className="sb-num">Ticket</th>
              <th className="sb-num">Orçamento</th>
              <th className="sb-num">Lucro estimado</th>
            </tr>
          </thead>
          <tbody>
            {sinais.campanhas.map((c) => {
              const { lucro } = estimar(c, margem.valor);

              return (
                <tr key={`${c.ml_account_id}:${String(c.campaign_id)}`}>
                  <td>
                    <strong>{c.nome}</strong>
                    <span className="sb-central-motivo">{c.conta}</span>
                  </td>
                  <td>
                    <StatePill tone={{ tom: NIVEL_ADS[c.nivel].tom, label: NIVEL_ADS[c.nivel].rotulo }} />
                  </td>
                  <td className="sb-num">{formatCurrency(c.investimento)}</td>
                  <td className="sb-num">{formatCurrency(c.receita_ads)}</td>
                  <td className="sb-num">{formatCount(c.unidades)}</td>
                  <td className="sb-num">
                    {formatRoas(c.roas)} / {formatRoas(c.roas_alvo)}
                  </td>
                  <td className="sb-num">{formatPercent(c.acos)}</td>
                  <td className="sb-num">{formatCurrency(c.cpc)}</td>
                  <td className="sb-num">{formatPercent(c.ctr)}</td>
                  <td className="sb-num">{formatPercent(c.conversao)}</td>
                  <td className="sb-num">{formatCurrency(c.cpa)}</td>
                  <td className="sb-num">{formatCurrency(c.ticket)}</td>
                  <td className="sb-num">{formatPercent(c.uso_orcamento)}</td>
                  <td className="sb-num">{formatCurrency(lucro)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ComoDecide({ sinais, margem }: { sinais: SinaisAds; margem: MargemDaSemana }): ReactNode {
  const { referencias } = sinais;

  return (
    <Panel
      title="Como os sinais são decididos"
      subtitle="Sete dias consolidados contra os sete anteriores, por campanha. O sistema aponta o que merece análise; a decisão é de quem gere a campanha."
    >
      <div className="sb-panel-body sb-sinal-metodo">
        <ul>
          <li>
            <strong>Crítico</strong> — gastou pelo menos R$ 50 e um dia de orçamento sem nenhuma venda atribuída, ou teve
            ROAS abaixo de 1 (o Ads custou mais do que vendeu).
          </li>
          <li>
            <strong>ROAS abaixo da meta</strong> — ROAS abaixo de 80% da meta que a própria campanha tem no Mercado Ads.
            Abaixo da meta por pouco é a oscilação normal de uma estratégia que mira o alvo, e não vira sinal.
          </li>
          <li>
            <strong>Atenção</strong> — o CPC subiu 20% e a conversão caiu 15% (100 cliques ou mais nas duas semanas), ou o
            gasto subiu 20% e o ROAS caiu 15%.
          </li>
          <li>
            <strong>Oportunidade de escala</strong> — campanha ativa, ROAS na meta ou acima, usando 90% do orçamento diário
            em média ou no teto em 4 dos 7 dias, com 5 unidades vendidas ou mais.
          </li>
        </ul>
        <p>
          CTR e conversão são comparados com a mediana das suas campanhas na mesma semana (CTR{" "}
          {formatPercent(referencias.ctr_mediano)}, conversão {formatPercent(referencias.conversao_mediana)} dos cliques),
          não com um número fixo. Campanha pausada não recebe sinal: quem pausou já agiu.
        </p>
        <p>
          <strong>Premissas:</strong> o lucro estimado aplica a {margem.rotulo}
          {margem.valor === null ? "" : ` (${formatPercent(margem.valor)})`} às vendas de cada campanha, porque a API de
          Product Ads não diz que produtos cada campanha vendeu. O orçamento é o da última leitura da campanha. O
          Mercado Livre publica o gasto e os cliques do dia antes das vendas atribuídas: dias com gasto e sem venda
          consolidada ficam de fora até a sincronização seguinte.
        </p>
      </div>
    </Panel>
  );
}
