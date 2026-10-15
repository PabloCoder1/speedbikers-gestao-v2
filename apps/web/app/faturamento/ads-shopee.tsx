import type { ReactNode } from "react";

import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { Panel } from "../../components/panel";
import {
  diasDasBarras,
  diasForaDaRazao,
  estadoAdsLoja,
  lojaAdsDeTeste,
  separarAdsShopee,
  type DiaAdsShopee,
  type LinhaAdsShopee,
} from "../../lib/ads-shopee";
import { formatCount, formatCurrency, formatDateTime, formatPercent } from "../../lib/format";
import { BarrasAds, formatRoas } from "./campanhas-ads";

interface Resposta<T> {
  readonly data: T[] | null;
  readonly error: { message: string; code?: string } | null;
}

const TITULO = "Ads CPC da loja — Shopee";

/**
 * OS ADS DA SHOPEE NO FATURAMENTO (D-456, etapa T5c; contrato C-63, D-449).
 *
 * Lê `get_shopee_ads_overview` (o resumo, TOTAL e por loja) e
 * `get_shopee_ads_daily` (a série), como o painel do Mercado Ads lê o dele. A
 * tela não soma nada.
 *
 * **É o Ads CPC da loja, não o total de Ads**: os anúncios GMV Max de loja
 * podem ficar de fora, e a documentação da Shopee não diz. Por isso:
 *
 * - o título e a nota dizem "CPC da loja";
 * - nada daqui é descontado do resultado da venda, até a conferência com loja
 *   real (D-449 §2);
 * - não soma com o Mercado Ads: as atribuições são diferentes.
 *
 * **Ausência não é zero**: Ads nunca lidos aparecem como "ainda não lidos",
 * não como R$ 0; o período fora da leitura é dito (`cobertura_completa`); dia
 * sem o valor não vira barra de zero.
 */
export async function AdsShopee({
  leitura,
  diaria,
  periodo,
}: {
  leitura: PromiseLike<Resposta<LinhaAdsShopee>>;
  diaria: PromiseLike<Resposta<DiaAdsShopee>>;
  periodo: string;
}): Promise<ReactNode> {
  const [resposta, serie] = await Promise.all([leitura, diaria]);

  /*
    A FUNÇÃO AINDA NÃO EXISTE NO BANCO (PGRST202): a web chega à produção antes
    da migration de D-449. A seção diz o que acontece, e o resto da tela segue.
  */
  if (resposta.error?.code === "PGRST202") {
    return (
      <Panel title={TITULO} subtitle={periodo}>
        <p className="sb-empty">
          A leitura dos Ads da Shopee ainda está sendo ativada neste ambiente — os números aparecem depois da primeira
          leitura das lojas.
        </p>
      </Panel>
    );
  }

  if (resposta.error !== null) {
    return (
      <Panel title={TITULO} subtitle={periodo}>
        <p role="alert" className="sb-note sb-note-perigo sb-campanhas-ml-aviso">
          Não foi possível carregar os Ads da Shopee: {resposta.error.message}
        </p>
      </Panel>
    );
  }

  const { total, lojas } = separarAdsShopee(resposta.data);

  return (
    <Panel
      title={TITULO}
      subtitle={`${periodo} · anúncios CPC das lojas, lidos da API oficial da Shopee${
        total?.ultima_atualizacao == null ? "" : ` em ${formatDateTime(total.ultima_atualizacao)}`
      }`}
    >
      <p role="note" className="sb-campanhas-ml-nota">
        Não é o total de Ads: os anúncios GMV Max de loja podem ficar de fora. Por isso nada daqui é descontado do
        resultado da venda, e não soma com o Mercado Ads.
      </p>

      {total === null ? (
        <>
          <p className="sb-empty">
            Nenhuma loja real com os Ads já lidos: sem números para o período. A leitura dos Ads começa sozinha depois
            da primeira leitura de pedidos de cada loja.
          </p>
          {lojas.length > 0 && <Lojas lojas={lojas} />}
        </>
      ) : (
        // Com números, as lojas vão na coluna ao lado da série, como as campanhas do Mercado Ads.
        <Resumo total={total} serie={serie} lojas={<Lojas lojas={lojas} />} />
      )}
    </Panel>
  );
}

function Resumo({
  total,
  serie,
  lojas,
}: {
  total: LinhaAdsShopee;
  serie: Resposta<DiaAdsShopee>;
  lojas: ReactNode;
}): ReactNode {
  const foraDaRazao = diasForaDaRazao(total);
  const celulas: KpiCellData[] = [
    {
      metricId: "shopee_investimento_ads",
      label: "Investimento em Ads CPC",
      formula: "SUM(expense) dos anúncios CPC da loja no período",
      value: formatCurrency(total.investimento),
      previous: null,
    },
    {
      metricId: "shopee_receita_ads",
      label: "Vendas com Ads",
      formula: "atribuição AMPLA da Shopee: qualquer item da loja até 7 dias depois do clique",
      value: formatCurrency(total.receita_ads),
      previous: null,
      ressalva: `direta (o item clicado) ${formatCurrency(total.receita_ads_direta)} · ${formatCount(total.pedidos_ads)} pedidos`,
    },
    {
      metricId: "shopee_roas",
      label: "ROAS",
      formula:
        "vendas com Ads ÷ investimento, só nos dias com os dois informados pela Shopee — venda sobre investimento, não lucro",
      value: formatRoas(total.roas),
      previous: null,
      // D-466: o dia sem um dos dois fica fora da razão e dentro dos cartões ao lado (D-455).
      ...(foraDaRazao === null ? {} : { ressalva: foraDaRazao }),
    },
    {
      metricId: "shopee_acos",
      label: "ACOS",
      formula: "investimento ÷ vendas com Ads, só nos dias com os dois informados pela Shopee",
      value: formatPercent(total.acos),
      previous: null,
      ...(foraDaRazao === null ? {} : { ressalva: foraDaRazao }),
    },
    {
      metricId: "shopee_tacos",
      label: "TACoS",
      formula: "investimento ÷ receita bruta das vendas válidas das mesmas lojas e dias",
      value: formatPercent(total.tacos),
      previous: null,
      ressalva: `sobre ${formatCurrency(total.receita_bruta)} de receita bruta`,
    },
  ];

  const { barras, semGasto, semVenda } = diasDasBarras(serie.data);
  const dias = (n: number): string => `${formatCount(n)} ${n === 1 ? "dia" : "dias"}`;

  return (
    <>
      {total.cobertura_completa === false && (
        <p role="note" className="sb-note sb-note-atencao sb-campanhas-ml-aviso">
          O período não está inteiro dentro da leitura dos Ads: os números são só dos dias já lidos (
          {formatCount(total.dias_lidos)} dias com dado). A leitura começa pelos últimos 90 dias e anda sozinha.
        </p>
      )}

      <div className="sb-campanhas-ml-faixa">
        <KpiStrip cells={celulas} />
      </div>

      <div className="sb-campanhas-ml-corpo">
        <div className="sb-campanhas-ml-coluna">
          <h3 className="sb-campanhas-ml-titulo">Investimento × vendas por dia</h3>
          {serie.error === null ? (
            <BarrasAds dias={barras} />
          ) : (
            <p role="alert" className="sb-note sb-note-perigo">
              Não foi possível carregar a série diária: {serie.error.message}
            </p>
          )}
          <p className="sb-campanhas-ml-nota">
            {formatCount(total.cliques)} cliques · {formatCount(total.impressoes)} impressões ·{" "}
            {formatCount(total.pedidos_ads)} pedidos com Ads.
            {semGasto > 0 &&
              ` ${dias(semGasto)} sem o gasto informado pela Shopee, fora das barras.`}
            {semVenda > 0 &&
              ` ${dias(semVenda)} sem as vendas informadas pela Shopee, fora das barras.`}{" "}
            A Shopee ainda atribui venda até 7 dias depois do clique: os últimos dias podem subir na próxima leitura.
          </p>
        </div>

        <div className="sb-campanhas-ml-coluna">{lojas}</div>
      </div>
    </>
  );
}

const ROTULO_DO_ESTADO = {
  nao_lido: "Ads ainda não lidos",
  sem_anuncio: "sem anúncio no período",
  com_anuncio: null,
} as const;

/** Uma linha por loja: o que cada uma investiu e devolveu, e o que não se sabe dela. */
function Lojas({ lojas }: { lojas: readonly LinhaAdsShopee[] }): ReactNode {
  return (
    <div>
      <h3 className="sb-campanhas-ml-titulo">Por loja</h3>
      <ul className="sb-valores" aria-label="Ads CPC por loja">
        {lojas.map((loja) => {
          const estado = estadoAdsLoja(loja);
          const deTeste = lojaAdsDeTeste(loja);
          const notas = [
            ROTULO_DO_ESTADO[estado],
            deTeste ? "loja de teste, fora do total" : null,
            estado !== "nao_lido" && loja.cobertura_completa === false ? "só os dias já lidos" : null,
            estado === "com_anuncio"
              ? `ROAS ${formatRoas(loja.roas)} · ACOS ${formatPercent(loja.acos)} · vendas com Ads ${formatCurrency(loja.receita_ads)}`
              : null,
            // D-466: o dia da loja sem um dos dois fica fora do ROAS dela (D-455).
            estado === "com_anuncio" ? diasForaDaRazao(loja) : null,
          ].filter((nota): nota is string => nota !== null);

          return (
            <li key={loja.account_id ?? loja.account_name}>
              <span className="sb-valores-rotulo">
                {loja.account_name ?? "Loja Shopee"}
                {deTeste ? " (teste)" : ""}
              </span>
              <strong className="sb-valores-valor">
                {estado === "nao_lido" ? "—" : formatCurrency(loja.investimento)}
              </strong>
              <span className="sb-valores-nota">{notas.join(" · ")}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
