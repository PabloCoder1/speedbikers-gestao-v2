import type { ReactNode } from "react";

import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { Panel } from "../../components/panel";
import { StatePill } from "../../components/state-pill";
import {
  campanhasEmAlerta,
  lerVisaoAds,
  rotuloEstrategia,
  rotuloStatusCampanha,
  tomDoRoas,
  type ContaAds,
  type DiaAds,
} from "../../lib/ads";
import { formatBusinessDate, formatCount, formatCurrency, formatDateTime, formatPercent } from "../../lib/format";

interface RespostaAds {
  readonly data: unknown;
  readonly error: { message: string; code?: string } | null;
}

const ROAS = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatRoas = (roas: number | null): string => (roas === null ? "—" : `${ROAS.format(roas)}x`);

/**
 * MERCADO ADS NO FATURAMENTO (D-363) — "o que as campanhas estão dando?".
 *
 * Tudo vem de `get_ads_overview`, que lê as métricas diárias sincronizadas da API
 * oficial de Product Ads. A tela não soma nada: resumo, campanhas e série saem
 * do SQL; aqui só se lê, dá tom e posiciona.
 *
 * **O vazio tem três causas, e cada uma é dita:** conta sem Product Ads
 * habilitado no Mercado Livre, conta ainda não verificada (o sync roda às 11h)
 * e conta habilitada sem campanha com métrica no período.
 */
export async function CampanhasAds({ leitura, periodo }: { leitura: Promise<RespostaAds>; periodo: string }): Promise<ReactNode> {
  const resposta = await leitura;

  /*
    A FUNÇÃO AINDA NÃO EXISTE NO BANCO (PGRST202). A web da branch principal
    vai para produção antes de a migration de D-363 passar pelo workflow de
    produção; nessa janela a seção diz o que está acontecendo em vez de um erro
    vermelho, e o resto do Faturamento segue igual.
  */
  if (resposta.error?.code === "PGRST202") {
    return (
      <section id="ads" className="sb-ads">
        <Panel title="Mercado Ads" subtitle={periodo}>
          <p className="sb-empty">
            A análise de campanhas do Mercado Ads ainda está sendo ativada neste ambiente — os dados aparecem depois da
            primeira sincronização.
          </p>
        </Panel>
      </section>
    );
  }

  if (resposta.error !== null) {
    return (
      <section id="ads" className="sb-ads">
        <Panel title="Mercado Ads" subtitle={periodo}>
          <p role="alert" className="sb-note sb-note-perigo sb-ads-aviso">
            Não foi possível carregar as campanhas: {resposta.error.message}
          </p>
        </Panel>
      </section>
    );
  }

  const visao = lerVisaoAds(resposta.data);

  if (visao === null) {
    return (
      <section id="ads" className="sb-ads">
        <Panel title="Mercado Ads" subtitle={periodo}>
          <p role="alert" className="sb-note sb-note-perigo sb-ads-aviso">
            A leitura das campanhas voltou fora do contrato esperado — nada é mostrado para não exibir número errado.
          </p>
        </Panel>
      </section>
    );
  }

  const { resumo, campanhas, diario, contas } = visao;
  const alerta = campanhasEmAlerta(campanhas);

  const celulas: KpiCellData[] = [
    {
      metricId: "investimento_ads",
      label: "Investimento em Ads",
      formula: "SUM(cost) das campanhas de Product Ads no período",
      value: formatCurrency(resumo.investimento),
      previous: null,
    },
    {
      metricId: "receita_ads",
      label: "Vendas com Ads",
      formula: "vendas diretas + indiretas atribuídas pelo Mercado Livre aos cliques",
      value: formatCurrency(resumo.receita_ads),
      previous: null,
    },
    {
      metricId: "roas",
      label: "ROAS",
      formula: "vendas com Ads ÷ investimento — quanto volta em venda para cada R$ 1",
      value: formatRoas(resumo.roas),
      previous: null,
    },
    {
      metricId: "acos",
      label: "ACOS",
      formula: "investimento ÷ vendas com Ads",
      value: formatPercent(resumo.acos),
      previous: null,
    },
    {
      metricId: "tacos",
      label: "TACoS",
      formula: "investimento em Ads ÷ receita bruta de TODAS as vendas válidas do período",
      value: formatPercent(resumo.tacos),
      previous: null,
    },
  ];

  const semNada = campanhas.length === 0;

  return (
    <section id="ads" className="sb-ads" aria-label="Mercado Ads">
      <Panel
        title="Mercado Ads — campanhas"
        subtitle={`${periodo} · Product Ads, sincronizado da API oficial do Mercado Livre${visao.sincronizadoEm === null ? "" : ` em ${formatDateTime(visao.sincronizadoEm)}`}`}
        aside={
          alerta > 0 ? (
            <span className="sb-status" style={{ background: "var(--sb-accent-soft)", color: "var(--sb-accent-ink)" }}>
              {formatCount(alerta)} campanha(s) abaixo do alvo
            </span>
          ) : undefined
        }
      >
        <EstadoDasContas contas={contas} />

        {semNada ? (
          <p className="sb-empty">
            {contas.some((c) => c.ads === "habilitado")
              ? "Nenhuma campanha com investimento neste período."
              : "Sem campanhas para mostrar: nenhuma conta com Product Ads habilitado e sincronizado."}
          </p>
        ) : (
          <>
            <div className="sb-ads-faixa">
              <KpiStrip cells={celulas} />
            </div>

            <div className="sb-ads-corpo">
              <div className="sb-ads-coluna">
                <h3 className="sb-ads-titulo">Investimento × vendas por dia</h3>
                <BarrasAds dias={diario} />
                <p className="sb-ads-nota">
                  {formatCount(resumo.cliques)} cliques · {formatCount(resumo.impressoes)} impressões · CTR{" "}
                  {formatPercent(resumo.ctr)} · CPC {formatCurrency(resumo.cpc)} · {formatCount(resumo.unidades)} unidades
                  vendidas por Ads. ROAS é venda sobre investimento, não lucro: com margem de 20%, um ROAS abaixo de 5
                  já consome a margem inteira.
                </p>
              </div>

              <div className="sb-ads-coluna">
                <h3 className="sb-ads-titulo">
                  Campanhas <small>por investimento</small>
                </h3>
                <ol className="sb-fat-lista sb-ads-lista" aria-label="Campanhas por investimento">
                  {campanhas.map((campanha, indice) => {
                    const status = rotuloStatusCampanha(campanha.status);
                    const estrategia = rotuloEstrategia(campanha.estrategia);

                    return (
                      <li key={`${campanha.ml_account_id}-${String(campanha.campaign_id)}`} className="sb-fat-item">
                        <span className="sb-fat-posicao" aria-hidden="true">
                          {indice + 1}
                        </span>

                        <span className="sb-fat-produto">
                          <strong className="sb-ads-nome" title={campanha.nome}>
                            {campanha.nome}
                          </strong>
                          <span className="sb-faturamento-sku">
                            {campanha.conta}
                            {estrategia === null ? "" : ` · ${estrategia}`}
                            {campanha.roas_alvo === null ? "" : ` · alvo ${formatRoas(campanha.roas_alvo)}`}
                          </span>
                        </span>

                        <span className="sb-fat-numeros">
                          <strong title="investimento no período">{formatCurrency(campanha.investimento)}</strong>
                          <StatePill tone={{ tom: tomDoRoas(campanha.roas, campanha.roas_alvo), label: `ROAS ${formatRoas(campanha.roas)}` }} />
                        </span>

                        <span className="sb-fat-detalhe">
                          <StatePill tone={status} /> vendas {formatCurrency(campanha.receita_ads)} · ACOS{" "}
                          {formatPercent(campanha.acos)} · {formatCount(campanha.cliques)} cliques
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>
          </>
        )}
      </Panel>
    </section>
  );
}

function EstadoDasContas({ contas }: { contas: readonly ContaAds[] }): ReactNode {
  const pendentes = contas.filter((c) => c.ads !== "habilitado");

  if (pendentes.length === 0) return null;

  return (
    <ul className="sb-ads-contas">
      {pendentes.map((conta) => (
        <li key={conta.ml_account_id}>
          <b>{conta.conta}</b>
          {conta.ads === "nao_habilitado"
            ? " — Product Ads não está habilitado nesta conta do Mercado Livre (Meu perfil › Publicidade)."
            : " — ainda não verificada: a leitura do Mercado Ads roda todo dia às 11h."}
        </li>
      ))}
    </ul>
  );
}

/**
 * Duas barras por dia no MESMO eixo (investimento e vendas com Ads), escala do
 * maior valor do período — nunca dois eixos, que fariam a barra menor parecer
 * maior. Dia sem linha não tem barra: a série vem só dos dias com métrica lida.
 */
function BarrasAds({ dias }: { dias: readonly DiaAds[] }): ReactNode {
  const maximo = Math.max(0, ...dias.map((d) => Math.max(d.investimento, d.receita_ads)));

  if (dias.length === 0 || maximo === 0) {
    return <p className="sb-empty">Nenhum dia com métrica neste período.</p>;
  }

  const altura = (valor: number): string => `${Math.max(valor > 0 ? 2 : 0, (valor / maximo) * 100).toFixed(1)}%`;

  return (
    <div className="sb-ads-barras" role="img" aria-label="Investimento e vendas com Ads por dia">
      {dias.map((dia) => (
        <div
          key={dia.dia}
          className="sb-ads-dia"
          title={`${formatBusinessDate(dia.dia)} · investimento ${formatCurrency(dia.investimento)} · vendas ${formatCurrency(dia.receita_ads)}`}
        >
          <i className="sb-ads-barra-venda" style={{ height: altura(dia.receita_ads) }} />
          <i className="sb-ads-barra-custo" style={{ height: altura(dia.investimento) }} />
        </div>
      ))}
      <span className="sb-ads-legenda" aria-hidden="true">
        <i className="sb-ads-barra-venda" /> vendas com Ads <i className="sb-ads-barra-custo" /> investimento
      </span>
    </div>
  );
}
