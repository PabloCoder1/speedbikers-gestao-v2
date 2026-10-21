import { previousBusinessDateRange, toSalesMetricDate } from "@sb/domain";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { CarregandoBloco } from "../../../components/carregando";
import { FilterMenu } from "../../../components/filter-menu";
import { KpiStrip, type KpiCellData } from "../../../components/kpi-strip";
import { EstadoDaTela, TENTAR_DE_NOVO, type AcaoDoEstado } from "../../../components/estado-da-tela";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { SeletorDeMarketplace } from "../../../components/seletor-marketplace";
import { StatePill } from "../../../components/state-pill";
import { FormularioFiltro } from "../../../components/formulario-filtro";
import { LinkDeFiltro } from "../../../components/link-de-filtro";
import { lerVisaoAds } from "../../../lib/ads";
import { lucroDoMercadoLivre } from "../../../lib/central-indicadores";
import { lerFaturamento, participacao, tomDaMargem, type SkuFaturamento } from "../../../lib/faturamento";
import {
  hrefDeFaturamento,
  linhasDaComparacao,
  lojaDeTeste,
  lojaNuncaLida,
  montarCascataShopee,
  motivosForaDaCobertura,
  separarLinhasShopee,
  skuParaALista,
  type FormatoDaComparacao,
  type LinhaFaturamentoShopee,
  type RecorteDeFaturamento,
  type SkuShopee,
} from "../../../lib/faturamento-multicanal";
import { formatBusinessDate, formatCount, formatCurrency, formatDateTime, formatPercent } from "../../../lib/format";
import { carregarLimites } from "../../../lib/limites-central";
import { DEFAULT_PERIOD_DAYS, PERIOD_PRESETS, resolvePeriodRange } from "../../../lib/period";
import { currentMembership } from "../../../lib/request-membership";
import { createClient } from "../../../lib/supabase/server";
import {
  HISTORICO_SHOPEE_DIAS,
  alternarConta,
  antesDoHistoricoShopee,
  hrefDeVendas,
  resolverContas,
  type ContaDoSeletor,
  type EscopoMulticanal,
  type Periodo,
} from "../../../lib/vendas-multicanal";
import { AdsShopee } from "./ads-shopee";
import { BarrasDiarias } from "./barras-diarias";
import { Cascata } from "./cascata";
import { ListaProdutos, type RespostaRpc } from "./numeros";
import { LIBERACOES_A_VISTA, RepasseShopee } from "./repasse-shopee";

/**
 * `/faturamento` COM A SHOPEE (D-442, etapa T5 da frente multicanal).
 *
 * `marketplace=shopee` é a conta da própria Shopee, lida do contrato C-58
 * (`get_shopee_faturamento`, D-437): resultado = o que a Shopee diz que a loja
 * recebe (escrow, já sem comissão, taxas, frete, cupons da loja e afiliados) −
 * o custo dos produtos, sobre os pedidos COBERTOS. O resultado vem inteiro e,
 * ao lado, separado em DEFINITIVO (pedido completo) e PROVISÓRIO (o escrow
 * ainda muda) — o dono quer os três (D-442).
 *
 * `marketplace=todos` põe o Mercado Livre (`get_faturamento`, D-356) e a Shopee
 * LADO A LADO, sem total: os dois resultados têm componentes diferentes
 * (`docs/METRICS.md` 5F × 5U), e a soma seria um número sem definição. A
 * receita, que soma, está consolidada em `/vendas?marketplace=todos`.
 *
 * **A tela não soma nada**: TOTAL, margem, imposto e cobertura vêm do SQL. A
 * loja de teste e a loja nunca lida aparecem só na tabela, fora das somas.
 */

type Consulta = Record<string, string | string[] | undefined>;

function rotuloDaLoja(conta: ContaDoSeletor): string {
  return `${conta.name}${conta.environment === "live" ? "" : " (teste)"}`;
}

function formatar(valor: number | null, formato: FormatoDaComparacao): string {
  if (formato === "moeda") return formatCurrency(valor);
  if (formato === "percentual") return formatPercent(valor);

  return formatCount(valor);
}

export async function FaturamentoMulticanal({
  query,
  escopo,
}: {
  query: Consulta;
  escopo: EscopoMulticanal;
}): Promise<ReactNode> {
  const supabase = await createClient();
  const hoje = toSalesMetricDate(new Date());

  const { range, days, invalidCustom } = resolvePeriodRange(query, hoje);
  const anterior = previousBusinessDateRange(range.from, range.to);
  const periodo: Periodo = days === null ? range : { days };

  const [membership, contasResult] = await Promise.all([
    currentMembership(),
    supabase
      .from("marketplace_accounts")
      .select("account_id, marketplace, name, environment")
      .order("marketplace", { ascending: true })
      .order("name", { ascending: true }),
  ]);

  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <>
        <PageTitle eyebrow="COMERCIAL / RESULTADOS" title="Faturamento" />
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </>
    );
  }

  const todasAsContas: ContaDoSeletor[] = contasResult.data ?? [];
  // No "Todos" não há recorte de loja (o lado do ML aceita uma conta só): o
  // link com `contas` cai inteiro, e a tela avisa.
  const { selecionadas, descartadas } =
    escopo === "shopee" ? resolverContas(query.contas, todasAsContas, "shopee") : { selecionadas: null, descartadas: 0 };
  const contasIgnoradas = escopo === "todos" && typeof query.contas === "string" && query.contas.trim() !== "";
  const recorte: RecorteDeFaturamento = { escopo, periodo, contas: selecionadas };
  // D-470: "Tentar de novo" é a mesma URL.
  const tentarDeNovo = hrefDeFaturamento(recorte);

  const lojas = todasAsContas.filter((conta) => conta.marketplace === "SHOPEE");
  const historicoCurto = antesDoHistoricoShopee(escopo === "shopee" ? anterior.from : range.from, hoje);
  const rotuloLojas =
    selecionadas === null
      ? "Todas as lojas"
      : selecionadas.length === 1
        ? (selecionadas[0]?.name ?? "1 loja")
        : `${String(selecionadas.length)} lojas`;
  const rotuloPeriodo = days === null ? "Período personalizado" : `Últimos ${String(days)} dias`;

  /*
    O repasse (D-458, C-64) e os Ads CPC da loja (D-456, C-63), só no recorte
    Shopee. As leituras partem AGORA (`Promise.resolve` dispara o builder do
    supabase-js) e chegam por streaming em seções próprias, como o Mercado Ads
    na tela do ML: não esperam o faturamento, nem o faturamento as espera.
  */
  const doPeriodoShopee = {
    p_organization_id: organizationId,
    p_date_from: range.from,
    p_date_to: range.to,
    p_account_ids: selecionadas === null ? null : selecionadas.map((conta) => conta.account_id),
  };
  const leiturasAds =
    escopo === "shopee"
      ? {
          leitura: Promise.resolve(supabase.rpc("get_shopee_ads_overview", doPeriodoShopee)),
          diaria: Promise.resolve(supabase.rpc("get_shopee_ads_daily", doPeriodoShopee)),
        }
      : null;
  const leiturasRepasse =
    escopo === "shopee"
      ? {
          leitura: Promise.resolve(supabase.rpc("get_shopee_repasse_overview", doPeriodoShopee)),
          // O "a liberar" é um retrato de agora: não tem período.
          pendente: Promise.resolve(
            supabase.rpc("get_shopee_repasse_pendente", {
              p_organization_id: organizationId,
              p_account_ids: doPeriodoShopee.p_account_ids,
            }),
          ),
          liberacoes: Promise.resolve(
            supabase.rpc("get_shopee_repasses", { ...doPeriodoShopee, p_limit: LIBERACOES_A_VISTA }),
          ),
        }
      : null;

  const corpo =
    escopo === "shopee" ? (
      <CorpoShopee
        organizationId={organizationId}
        recorte={recorte}
        range={range}
        anterior={anterior}
      />
    ) : (
      <CorpoTodos organizationId={organizationId} recorte={recorte} range={range} />
    );

  return (
    <>
      <PageTitle
        eyebrow="COMERCIAL / RESULTADOS"
        title="Faturamento"
        subtitle={
          escopo === "shopee" ? (
            <>
              Shopee, {formatBusinessDate(range.from)} até {formatBusinessDate(range.to)} — comparado com{" "}
              {formatBusinessDate(anterior.from)} até {formatBusinessDate(anterior.to)}.
            </>
          ) : (
            <>
              Mercado Livre e Shopee lado a lado, {formatBusinessDate(range.from)} até {formatBusinessDate(range.to)}.
            </>
          )
        }
        aside={
          <>
            <SeletorDeMarketplace
              ativo={escopo}
              contas={{
                ml: contasResult.error === null ? todasAsContas.length - lojas.length : null,
                shopee: contasResult.error === null ? lojas.length : null,
              }}
              destinos={{
                todos: hrefDeFaturamento(recorte, { escopo: "todos" }),
                ml: hrefDeFaturamento(recorte, { escopo: "ml" }),
                shopee: hrefDeFaturamento(recorte, { escopo: "shopee" }),
              }}
            />

            {/* As lojas, uma por clique, num valor só na URL — como em /vendas (D-440). */}
            {escopo === "shopee" && lojas.length > 0 && (
              <FilterMenu
                nome="Lojas"
                rotulo={rotuloLojas}
                opcoes={[
                  { href: hrefDeFaturamento(recorte, { contas: null }), ativo: selecionadas === null, label: "Todas as lojas" },
                  ...lojas.map((loja) => {
                    const marcada = selecionadas?.some((c) => c.account_id === loja.account_id) ?? false;

                    return {
                      href: hrefDeFaturamento(recorte, { contas: alternarConta(selecionadas, loja) }),
                      ativo: marcada,
                      label: `${marcada ? "✓ " : ""}${rotuloDaLoja(loja)}`,
                    };
                  }),
                ]}
              />
            )}

            <FilterMenu
              nome="Período"
              rotulo={rotuloPeriodo}
              opcoes={PERIOD_PRESETS.map((preset) => ({
                href: hrefDeFaturamento(recorte, { periodo: { days: preset } }),
                ativo: days === preset,
                label: `Últimos ${String(preset)} dias`,
              }))}
            >
              {/* Um GET nativo envia só os campos do formulário: os hidden mantêm o recorte. */}
              <FormularioFiltro action="/faturamento" className="sb-periodo-form">
                <input type="hidden" name="marketplace" value={escopo} />
                {selecionadas !== null && (
                  <input type="hidden" name="contas" value={selecionadas.map((conta) => conta.account_id).join(",")} />
                )}
                <input
                  type="date"
                  name="from"
                  defaultValue={days === null ? range.from : undefined}
                  aria-label="Data inicial"
                  className="sb-input"
                />
                <input
                  type="date"
                  name="to"
                  defaultValue={days === null ? range.to : undefined}
                  aria-label="Data final"
                  className="sb-input"
                />
                <button type="submit" className="sb-button sb-button-primary">
                  Aplicar período
                </button>
              </FormularioFiltro>
            </FilterMenu>

            <Link className="sb-button" href={hrefDeVendas({ escopo, periodo, contas: selecionadas, metrica: "faturamento" })}>
              Dashboard de vendas
            </Link>
          </>
        }
      />

      {contasResult.error !== null && (
        <EstadoDaTela
          tipo="erro"
          titulo="Não foi possível carregar as contas e lojas"
          descricao="O seletor e o filtro de lojas estão indisponíveis."
          detalhe={contasResult.error.message}
          acao={{ href: tentarDeNovo, rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      )}

      {descartadas > 0 && (
        <p role="note" className="sb-an-nota">
          {descartadas === 1
            ? "1 loja do link não está disponível para você neste recorte e ficou de fora."
            : `${String(descartadas)} lojas do link não estão disponíveis para você neste recorte e ficaram de fora.`}
        </p>
      )}

      {contasIgnoradas && (
        <p role="note" className="sb-an-nota">
          O recorte por conta não vale lado a lado: o faturamento do Mercado Livre aceita uma conta só. Mostrando todas —
          para recortar, abra o marketplace.
        </p>
      )}

      {invalidCustom && (
        <p role="status" className="sb-note sb-note-atencao" style={{ margin: "0 0 var(--sb-space-3)" }}>
          Período personalizado inválido — mostrando os últimos {DEFAULT_PERIOD_DAYS} dias.
        </p>
      )}

      {/* O cabeçalho e os filtros saem antes; os números chegam por streaming, como na tela do ML. */}
      {/* A janela reservada, como na tela do ML (D-515; medida do A3 na D-526): o repasse e os Ads da
          Shopee vêm abaixo e não podem ser empurrados quando os números chegam. */}
      <Suspense fallback={<CarregandoBloco rotulo="faturamento" altura="100vh" />}>{corpo}</Suspense>

      {/* O realizado ao lado do previsto: logo depois do resultado, antes dos Ads. */}
      {leiturasRepasse !== null && (
        <section id="repasse" className="sb-campanhas-ml" aria-label="Repasse da Shopee">
          <Suspense
            fallback={
              <Panel title="Repasse da Shopee" subtitle="Carregando o que a Shopee liberou no período">
                <CarregandoBloco rotulo="repasses da Shopee" />
              </Panel>
            }
          >
            <RepasseShopee
              tentarDeNovo={tentarDeNovo}
              leitura={leiturasRepasse.leitura}
              pendente={leiturasRepasse.pendente}
              liberacoes={leiturasRepasse.liberacoes}
              periodo={`${formatBusinessDate(range.from)} até ${formatBusinessDate(range.to)}`}
            />
          </Suspense>
        </section>
      )}

      {leiturasAds !== null && (
        <section id="ads" className="sb-campanhas-ml" aria-label="Ads CPC da loja Shopee">
          <Suspense
            fallback={
              <Panel title="Ads CPC da loja — Shopee" subtitle="Carregando o investimento e as vendas com Ads do período">
                <CarregandoBloco rotulo="Ads da Shopee" />
              </Panel>
            }
          >
            <AdsShopee
              tentarDeNovo={tentarDeNovo}
              leitura={leiturasAds.leitura}
              diaria={leiturasAds.diaria}
              periodo={`${formatBusinessDate(range.from)} até ${formatBusinessDate(range.to)}`}
            />
          </Suspense>
        </section>
      )}

      {historicoCurto && (
        <p role="note" className="sb-an-nota" style={{ marginTop: "var(--sb-space-3)" }}>
          A Shopee guarda {String(HISTORICO_SHOPEE_DIAS)} dias de histórico: um período mais antigo que isso subestima a
          Shopee{escopo === "shopee" ? ", e a comparação com o período anterior também" : ""}.
        </p>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Shopee                                                              */
/* ------------------------------------------------------------------ */

async function CorpoShopee({
  organizationId,
  recorte,
  range,
  anterior,
}: {
  organizationId: string;
  recorte: RecorteDeFaturamento;
  range: { from: string; to: string };
  anterior: { from: string; to: string };
}): Promise<ReactNode> {
  const supabase = await createClient();
  const contas = recorte.contas === null ? null : recorte.contas.map((conta) => conta.account_id);
  const acao: AcaoDoEstado = { href: hrefDeFaturamento(recorte), rotulo: TENTAR_DE_NOVO, mesmaTela: true };
  // Com lojas escolhidas, o vazio é do recorte e "Limpar filtros" volta a todas.
  const vazio = {
    tipo: recorte.contas === null ? ("vazio" as const) : ("filtro" as const),
    acao:
      recorte.contas === null
        ? undefined
        : { href: hrefDeFaturamento(recorte, { contas: null }), rotulo: "Limpar filtros", mesmaTela: true },
  };

  const doPeriodo = { p_organization_id: organizationId, p_date_from: range.from, p_date_to: range.to, p_account_ids: contas };

  // Tudo numa ida (D-185): o C-58 do período e do anterior e, do C-61 (D-452),
  // a composição do recebido, a série diária e os produtos -- sobre os MESMOS
  // pedidos cobertos. Cada leitura nova falha sozinha, no painel dela.
  const [atualResult, anteriorResult, limites, composicaoResult, diarioResult, maisReceitaResult, menorMargemResult] = await Promise.all([
    supabase.rpc("get_shopee_faturamento", {
      p_organization_id: organizationId,
      p_date_from: range.from,
      p_date_to: range.to,
      p_account_ids: contas,
    }),
    supabase.rpc("get_shopee_faturamento", {
      p_organization_id: organizationId,
      p_date_from: anterior.from,
      p_date_to: anterior.to,
      p_account_ids: contas,
    }),
    carregarLimites(supabase, organizationId),
    supabase.rpc("get_shopee_faturamento_composicao", doPeriodo),
    supabase.rpc("get_shopee_faturamento_diario", doPeriodo),
    supabase.rpc("get_shopee_faturamento_por_sku", { ...doPeriodo, p_ordem: "receita", p_limit: 30 }),
    supabase.rpc("get_shopee_faturamento_por_sku", { ...doPeriodo, p_ordem: "margem", p_limit: 20 }),
  ]);

  if (atualResult.error !== null) {
    return (
      <EstadoDaTela
        tipo="erro"
        titulo="Não foi possível carregar o faturamento da Shopee"
        detalhe={atualResult.error.message}
        acao={acao}
      />
    );
  }

  const { total, lojas } = separarLinhasShopee(atualResult.data);
  // Falhar o período anterior não pode parecer "o anterior não vendeu" (D-067).
  const totalAnterior = anteriorResult.error === null ? separarLinhasShopee(anteriorResult.data).total : null;
  const margemMinima = limites.margemMinima;
  const composicao =
    composicaoResult.error === null ? (composicaoResult.data.find((linha) => linha.nivel === "TOTAL") ?? null) : null;
  const cascata =
    total === null ? null : montarCascataShopee(composicao, total.custo_produtos, total.resultado_venda, total.ajustes_cobertos);

  return (
    <>
      {anteriorResult.error !== null && (
        <EstadoDaTela
          tipo="erro"
          titulo="O período anterior não carregou"
          descricao="A comparação foi omitida, e isso não é zero."
          detalhe={anteriorResult.error.message}
          acao={acao}
        />
      )}

      <KpiStrip ancora cells={celulasShopee(total, totalAnterior, margemMinima)} />

      <p role="note" className="sb-an-nota">
        Resultado = o que a Shopee diz que a loja recebe (escrow) + os ajustes que ela cobra depois do repasse − o
        custo dos produtos. Não soma com o resultado do Mercado Livre, que desconta menos coisas —{" "}
        <LinkDeFiltro href={hrefDeFaturamento(recorte, { escopo: "todos" })}>veja os dois lado a lado</LinkDeFiltro>. A loja Shopee de
        teste nunca entra nas somas.
      </p>

      {total !== null && (
        <div className="sb-lower-grid" style={{ marginTop: "var(--sb-space-3)" }}>
          <Panel
            title="Para onde vai o dinheiro"
            subtitle={
              cascata === null
                ? "Da receita ao resultado, componente a componente."
                : `${formatCount(total.pedidos_cobertos)} pedidos cobertos, ${formatPercent(participacao(total.receita_coberta, total.receita_bruta))} da receita do período — tudo sobre os mesmos pedidos.`
            }
          >
            <div className="sb-panel-body">
              {composicaoResult.error !== null && (
                <EstadoDaTela
                  tipo="erro"
                  titulo="Não foi possível carregar a composição do recebido"
                  detalhe={composicaoResult.error.message}
                  acao={acao}
                />
              )}

              {composicaoResult.error === null && cascata === null && (
                <EstadoDaTela
                  tipo={vazio.tipo}
                  titulo="Nenhum pedido coberto tem a composição do recebido lida neste período"
                  descricao="Sem cascata, em vez de uma de zeros."
                  acao={vazio.acao}
                />
              )}

              {cascata !== null && (
                <>
                  <Cascata degraus={cascata.degraus} />
                  <p className="sb-cascata-margem">
                    Margem sobre a venda <strong>{formatPercent(total.margem_venda)}</strong>{" "}
                    <span>= resultado ÷ receita dos mesmos pedidos</span>
                  </p>
                  {cascata.naoInformados.length > 0 && (
                    <p className="sb-an-nota">A Shopee não informou, em nenhum pedido coberto: {cascata.naoInformados.join(", ")}.</p>
                  )}
                  {cascata.zerados.length > 0 && (
                    <p className="sb-an-nota">Sem valor no período: {cascata.zerados.join(", ")}.</p>
                  )}
                </>
              )}

              <ul className="sb-valores">
                <li title="receita coberta × alíquota vigente no dia">
                  <span className="sb-valores-rotulo">Imposto estimado</span>
                  <strong className="sb-valores-valor">{formatCurrency(total.imposto_coberto)}</strong>
                  <span className="sb-valores-nota">
                    {(total.pedidos_sem_aliquota ?? 0) > 0 ? (
                      <>
                        {formatCount(total.pedidos_sem_aliquota)} pedidos sem alíquota no dia: o imposto não é parcial ·{" "}
                        <Link href="/central/metas">cadastrar alíquota</Link>
                      </>
                    ) : (
                      "pela alíquota vigente no dia de cada pedido"
                    )}
                  </span>
                </li>
                <li title="resultado_venda − imposto estimado">
                  <span className="sb-valores-rotulo">Resultado após imposto</span>
                  <strong className="sb-valores-valor">{formatCurrency(total.resultado_apos_imposto)}</strong>
                  <span className="sb-valores-nota">
                    margem após imposto {formatPercent(total.margem_apos_imposto)} · o Ads entra na linha abaixo
                  </span>
                </li>
                {/*
                  D-487: o lucro após imposto e Ads, pronto no SQL (a regra do 5K do ML).
                  Nulo diz por quê -- a coluna que veio nula é o motivo (sem alíquota,
                  ou o Ads que não cobre o período).
                */}
                <li title="resultado após imposto − Ads CPC da loja × (receita coberta ÷ receita bruta)">
                  <span className="sb-valores-rotulo">Lucro após imposto e Ads</span>
                  <strong className="sb-valores-valor">{formatCurrency(total.resultado_contribuicao)}</strong>
                  <span className="sb-valores-nota">
                    {total.resultado_apos_imposto === null
                      ? "sem o imposto, sem a contribuição: cadastre a alíquota"
                      : total.investimento_ads === null
                        ? "a leitura de Ads da loja não cobre o período inteiro"
                        : `margem de contribuição ${formatPercent(total.margem_contribuicao)} · Ads CPC da loja de ${formatCurrency(total.investimento_ads)}, ${formatCurrency(total.ads_rateado)} rateado pela receita coberta · sem custos fixos; o GMV Max fica fora`}
                  </span>
                </li>
                {/*
                  Os informativos do C-61, fora da cascata: cada um com o valor
                  que veio do banco, sem total -- somar aqui seria agregar fora
                  do SQL. Nulo (nenhum pedido informou) não aparece.
                */}
                {composicao !== null &&
                  (
                    [
                      ["Cupons da Shopee", composicao.cupom_shopee, "bancado pela Shopee — não sai do recebido da loja"],
                      ["Moedas da Shopee", composicao.moedas_shopee, "bancado pela Shopee — não sai do recebido da loja"],
                      ["Desconto da Shopee", composicao.desconto_shopee, "bancado pela Shopee — não sai do recebido da loja"],
                      [
                        "Comissão líquida (Brasil)",
                        composicao.comissao_liquida,
                        "informativo: a cascata usa a comissão do escrow; a diferença, se houver, cai em Outros",
                      ],
                      [
                        "Taxa de serviço líquida (Brasil)",
                        composicao.taxa_servico_liquida,
                        "informativo: a cascata usa a taxa do escrow; a diferença, se houver, cai em Outros",
                      ],
                    ] as const
                  )
                    .filter(([, valor]) => valor !== null)
                    .map(([rotulo, valor, nota]) => (
                      <li key={rotulo} title="informativo do C-61: não entra na cascata">
                        <span className="sb-valores-rotulo">{rotulo}</span>
                        <strong className="sb-valores-valor">{formatCurrency(valor)}</strong>
                        <span className="sb-valores-nota">{nota}</span>
                      </li>
                    ))}
              </ul>
            </div>
          </Panel>

          <Panel
            title="Definitivo e provisório"
            subtitle="O escrow só fecha quando o pedido completa: até lá o resultado ainda pode mudar."
          >
            {/* Lista, não grade de cartões: na coluna estreita, ao lado da cascata, três cartões não cabem. */}
            <ul className="sb-valores">
              <li title="resultado dos pedidos COMPLETED">
                <span className="sb-valores-rotulo">Definitivo</span>
                <strong className="sb-valores-valor">{formatCurrency(total.resultado_definitivo)}</strong>
                <span className="sb-valores-nota">{formatCount(total.pedidos_definitivos)} pedidos completos</span>
              </li>
              <li title="resultado dos pedidos ainda em andamento">
                <span className="sb-valores-rotulo">Provisório</span>
                <strong className="sb-valores-valor">{formatCurrency(total.resultado_provisorio)}</strong>
                <span className="sb-valores-nota">
                  {formatCount(total.pedidos_provisorios)} pedidos ainda em andamento · o escrow pode mudar
                </span>
              </li>
              <li title="recebido − custo dos pedidos cobertos">
                <span className="sb-valores-rotulo">Resultado da venda</span>
                <strong className="sb-valores-valor">{formatCurrency(total.resultado_venda)}</strong>
                <span className="sb-valores-nota">os dois juntos · {formatCount(total.pedidos_cobertos)} pedidos cobertos</span>
              </li>
            </ul>
          </Panel>
        </div>
      )}

      {total !== null && (
        <div style={{ marginTop: "var(--sb-space-3)" }}>
          <Panel
            title="Receita e margem por dia"
            subtitle="A receita é de todos os pedidos válidos; a margem, dos pedidos cobertos de cada dia. Dia de receita desconhecida fica sem barra."
          >
            {diarioResult.error !== null ? (
              <EstadoDaTela
                tipo="erro"
                titulo="Não foi possível carregar a série diária"
                detalhe={diarioResult.error.message}
                acao={acao}
              />
            ) : diarioResult.data.length === 0 ? (
              <EstadoDaTela tipo={vazio.tipo} titulo="Nenhuma venda válida neste período" acao={vazio.acao} />
            ) : (
              <BarrasDiarias dias={diarioResult.data} rangeFrom={range.from} rangeTo={range.to} margemMinima={margemMinima} />
            )}
          </Panel>
        </div>
      )}

      {total !== null && (
        <div className="sb-pair-grid">
          <Panel
            title="Produtos que mais faturaram"
            subtitle={
              maisReceitaResult.error === null
                ? notaDosProdutos(maisReceitaResult.data, "receita")
                : "a leitura dos produtos falhou"
            }
          >
            <ProdutosShopee resultado={maisReceitaResult} modo="receita" margemMinima={margemMinima} acao={acao} vazio={vazio} />
          </Panel>
          <Panel
            title="Menor margem"
            subtitle={
              menorMargemResult.error === null
                ? notaDosProdutos(menorMargemResult.data, "margem")
                : "a leitura dos produtos falhou"
            }
          >
            <ProdutosShopee resultado={menorMargemResult} modo="margem" margemMinima={margemMinima} acao={acao} vazio={vazio} />
          </Panel>
        </div>
      )}

      <div style={{ marginTop: "var(--sb-space-3)" }}>
        <TabelaLojas total={total} lojas={lojas} margemMinima={margemMinima} vazio={vazio} />
      </div>

      <div style={{ marginTop: "var(--sb-space-3)" }}>
        <Cobertura total={total} />
      </div>
    </>
  );
}

/**
 * A frase das listas de produtos da Shopee. Só entra pedido de UM produto: o
 * recebido é do pedido, e ratear entre produtos inventaria uma margem (C-61).
 * O que ficou de fora é dito.
 */
function notaDosProdutos(linhas: readonly SkuShopee[], modo: "receita" | "margem"): string {
  const primeira = linhas[0];
  const fora =
    primeira === undefined || primeira.pedidos_varios_skus === 0
      ? ""
      : ` · ${formatCount(primeira.pedidos_varios_skus)} pedidos com mais de um produto (${formatCurrency(primeira.receita_varios_skus)}) ficam fora`;

  return modo === "receita"
    ? `top ${String(linhas.length)} de ${formatCount(primeira?.total_count ?? 0)} produtos com venda${fora}`
    : `da pior para a melhor, só pedidos cobertos${fora}`;
}

function ProdutosShopee({
  resultado,
  modo,
  margemMinima,
  acao,
  vazio,
}: {
  resultado: { data: SkuShopee[] | null; error: { message: string } | null };
  modo: "receita" | "margem";
  margemMinima: number;
  acao: AcaoDoEstado;
  vazio: VazioDoRecorte;
}): ReactNode {
  if (resultado.error !== null) {
    return <EstadoDaTela tipo="erro" titulo="Não foi possível carregar os produtos" detalhe={resultado.error.message} acao={acao} />;
  }

  const linhas = (resultado.data ?? []).map(skuParaALista).filter((linha): linha is SkuFaturamento => linha !== null);

  return linhas.length === 0 ? (
    <EstadoDaTela
      tipo={vazio.tipo}
      titulo={modo === "receita" ? "Nenhum produto vinculado vendeu neste período" : "Nenhum produto com pedido coberto neste período"}
      acao={vazio.acao}
    />
  ) : (
    <ListaProdutos linhas={linhas} modo={modo} margemMinima={margemMinima} />
  );
}

function celulasShopee(
  total: LinhaFaturamentoShopee | null,
  anterior: LinhaFaturamentoShopee | null,
  margemMinima: number,
): KpiCellData[] {
  const antes = (valor: (l: LinhaFaturamentoShopee) => string): string | null =>
    anterior === null ? null : valor(anterior);
  const tom = tomDaMargem(total?.margem_venda ?? null, margemMinima);
  const semCobertura = total !== null && (total.pedidos_cobertos ?? 0) === 0;

  const celulas: KpiCellData[] = [
    {
      metricId: "shopee_receita_bruta",
      label: "Receita bruta",
      formula: "Produtos com o desconto da loja, sem frete e antes dos cupons da Shopee, dos pedidos válidos",
      value: formatCurrency(total?.receita_bruta ?? null),
      previous: antes((l) => formatCurrency(l.receita_bruta)),
      ...(total === null
        ? {}
        : {
            ressalva: `${formatCount(total.pedidos)} pedidos${
              (total.pedidos_sem_receita ?? 0) > 0
                ? ` · ${formatCount(total.pedidos_sem_receita)} sem receita conhecida, fora da soma`
                : ""
            }`,
          }),
    },
    {
      metricId: "shopee_resultado_venda",
      label: "Resultado da venda",
      formula: "recebido (escrow) − custo dos produtos, sobre os pedidos cobertos",
      value: formatCurrency(total?.resultado_venda ?? null),
      previous: antes((l) => formatCurrency(l.resultado_venda)),
      ...(total === null
        ? {}
        : {
            ressalva: semCobertura
              ? "nenhum pedido coberto no período"
              : `sobre ${formatPercent(participacao(total.receita_coberta, total.receita_bruta))} da receita (${formatCount(total.pedidos_cobertos)} pedidos)`,
          }),
    },
    {
      metricId: "shopee_margem_venda",
      label: "Margem sobre a venda",
      formula: "resultado ÷ receita dos mesmos pedidos cobertos",
      value: formatPercent(total?.margem_venda ?? null),
      previous: antes((l) => formatPercent(l.margem_venda)),
      ressalva: "não é lucro líquido: imposto à parte",
      ...(tom === "perigo" || tom === "atencao" ? { destaque: tom } : {}),
    },
    {
      metricId: "shopee_recebido",
      label: "Recebido da Shopee",
      formula: "escrow_amount dos pedidos cobertos: já sem comissão, taxas, frete da loja, cupons da loja e afiliados",
      value: formatCurrency(total?.recebido_coberto ?? null),
      previous: antes((l) => formatCurrency(l.recebido_coberto)),
      ressalva: "dos pedidos cobertos, antes do custo",
    },
    {
      metricId: "shopee_resultado_apos_imposto",
      label: "Resultado após imposto",
      formula: "resultado da venda − receita coberta × alíquota do dia",
      value: formatCurrency(total?.resultado_apos_imposto ?? null),
      previous: antes((l) => formatCurrency(l.resultado_apos_imposto)),
      ...(total === null
        ? {}
        : {
            ressalva:
              (total.pedidos_sem_aliquota ?? 0) > 0
                ? `${formatCount(total.pedidos_sem_aliquota)} pedidos sem alíquota no dia`
                : `margem ${formatPercent(total.margem_apos_imposto)}`,
          }),
    },
  ];

  // Sem nada somável (só loja de teste, ou nenhuma lida), o "—" diz por quê.
  return total === null
    ? celulas.map((celula) => ({ ...celula, ressalva: "nenhuma loja com venda somável neste recorte" }))
    : celulas;
}

/** A pílula da margem, com o tom da margem mínima da organização (D-410). */
function Margem({ margem, margemMinima }: { margem: number | null; margemMinima: number }): ReactNode {
  if (margem === null) return <span className="sb-texto-suave">sem cobertura</span>;

  return <StatePill tone={{ tom: tomDaMargem(margem, margemMinima), label: formatPercent(margem) }} />;
}

/** O vazio de um painel do recorte: "nada ainda" com todas as lojas, "filtro sem resultado" com algumas (D-470). */
interface VazioDoRecorte {
  readonly tipo: "vazio" | "filtro";
  readonly acao: AcaoDoEstado | undefined;
}

function TabelaLojas({
  total,
  lojas,
  margemMinima,
  vazio,
}: {
  total: LinhaFaturamentoShopee | null;
  lojas: readonly LinhaFaturamentoShopee[];
  margemMinima: number;
  vazio: VazioDoRecorte;
}): ReactNode {
  return (
    <Panel
      title="Por loja"
      subtitle="Recebido, custo, resultado e margem sobre os pedidos cobertos de cada loja. O total soma só as lojas reais já lidas."
    >
      {lojas.length === 0 ? (
        <EstadoDaTela tipo={vazio.tipo} titulo="Nenhuma loja Shopee neste recorte" acao={vazio.acao} />
      ) : (
        <div className="sb-faturamento-tabela">
          <table className="sb-table" aria-label="Faturamento por loja Shopee">
            <thead>
              <tr>
                <th>Loja</th>
                <th className="sb-num">Pedidos</th>
                <th className="sb-num">Receita</th>
                <th className="sb-num">Recebido</th>
                <th className="sb-num">Custo</th>
                <th className="sb-num">Resultado</th>
                <th className="sb-num">Margem</th>
                <th className="sb-num">Após imposto</th>
                <th className="sb-num">Cobertura</th>
              </tr>
            </thead>
            <tbody>
              <LinhaDaLoja linha={total} rotulo="Total das lojas somáveis" soma margemMinima={margemMinima} />
              {lojas.map((loja) => (
                <LinhaDaLoja
                  key={loja.account_id ?? loja.account_name}
                  linha={loja}
                  rotulo={loja.account_name ?? "—"}
                  margemMinima={margemMinima}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/**
 * Uma linha da tabela. O total em negrito, as lojas abaixo. A loja de teste
 * leva a marca e "fora das somas"; a nunca lida tem tudo NULO e mostra "—".
 */
function LinhaDaLoja({
  linha,
  rotulo,
  soma = false,
  margemMinima,
}: {
  linha: LinhaFaturamentoShopee | null;
  rotulo: string;
  soma?: boolean;
  margemMinima: number;
}): ReactNode {
  const estilo = soma ? { fontWeight: 700 } : undefined;

  return (
    <tr>
      <td style={soma ? estilo : { paddingLeft: "1.5rem" }}>
        {rotulo}
        {soma && linha === null && (
          <small className="sb-an-sub" style={{ fontWeight: 400 }}>
            nada somável: só loja de teste ou ainda não lida
          </small>
        )}
        {linha !== null && lojaDeTeste(linha) && (
          <span className="sb-an-meta">
            <StatePill tone={{ tom: "atencao", label: "Teste" }} /> fora das somas
          </span>
        )}
        {linha !== null && lojaNuncaLida(linha) && <small className="sb-an-sub">pedidos ainda não lidos</small>}
        {!soma && linha !== null && !lojaNuncaLida(linha) && (
          <small className="sb-an-sub">atualizado até {formatDateTime(linha.ultima_atualizacao)}</small>
        )}
      </td>
      <td className="sb-num" style={estilo}>
        {formatCount(linha?.pedidos ?? null)}
      </td>
      <td className="sb-num" style={estilo}>
        {formatCurrency(linha?.receita_bruta ?? null)}
      </td>
      <td className="sb-num" style={estilo}>
        {formatCurrency(linha?.recebido_coberto ?? null)}
      </td>
      <td className="sb-num" style={estilo}>
        {formatCurrency(linha?.custo_produtos ?? null)}
      </td>
      <td className="sb-num" style={estilo}>
        {formatCurrency(linha?.resultado_venda ?? null)}
      </td>
      <td className="sb-num">
        {linha === null || lojaNuncaLida(linha) ? "—" : <Margem margem={linha.margem_venda} margemMinima={margemMinima} />}
      </td>
      <td className="sb-num" style={estilo}>
        {formatCurrency(linha?.resultado_apos_imposto ?? null)}
      </td>
      <td className="sb-num" title="pedidos cobertos ÷ pedidos" style={estilo}>
        {formatPercent(participacao(linha?.pedidos_cobertos ?? null, linha?.pedidos ?? null))}
      </td>
    </tr>
  );
}

function Cobertura({ total }: { total: LinhaFaturamentoShopee | null }): ReactNode {
  return (
    <Panel
      title="O que estes números cobrem"
      subtitle="Receita e pedidos valem para todos os pedidos válidos. Recebido, custo, resultado e margem, só para os cobertos."
    >
      <div className="sb-panel-body">
        {total === null ? (
          <EstadoDaTela
            tipo="vazio"
            titulo="Nenhuma loja real com pedidos lidos neste recorte"
            descricao="Não há o que cobrir. A loja de teste e a loja nunca lida ficam fora das somas."
          />
        ) : (
          <div className="sb-stat-grid">
            <div className="sb-stat">
              <span className="sb-stat-label">Pedidos cobertos</span>
              <strong className="sb-stat-value">
                {formatCount(total.pedidos_cobertos)} de {formatCount(total.pedidos)}
              </strong>
              <span className="sb-stat-note">
                {formatPercent(participacao(total.receita_coberta, total.receita_bruta))} da receita · entram no resultado e
                na margem
              </span>
            </div>
            {motivosForaDaCobertura(total).map((motivo) => (
              <div key={motivo.chave} className="sb-stat">
                <span className="sb-stat-label">{motivo.rotulo}</span>
                <strong className="sb-stat-value">{formatCount(motivo.pedidos)}</strong>
                <span className="sb-stat-note">
                  {motivo.nota}
                  {motivo.link !== null && (
                    <>
                      {" · "}
                      <Link href={motivo.link.href}>{motivo.link.texto}</Link>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="sb-note sb-faturamento-nota">
          <span>COMO LER</span>
          <p>
            <strong>Resultado não é lucro líquido.</strong> Imposto (mostrado à parte), Ads da Shopee e despesas fixas ficam
            fora.
          </p>
          <p>
            Um pedido pode estar fora da cobertura por mais de um motivo — sem financeiro e sem produto, por exemplo — e por
            isso os motivos não somam até os pedidos que faltam.
          </p>
          {total !== null && (
            <p>
              O custo é o da data do pedido, pelo histórico de custo — a mesma regra do Mercado Livre.{" "}
              {(total.pedidos_custo_atual ?? 0) === 0
                ? "Todos os pedidos cobertos tinham histórico."
                : `${formatCount(total.pedidos_custo_atual)} pedidos cobertos usaram o custo atual, por não haver histórico anterior à venda.`}
            </p>
          )}
          <p>
            O recebido ainda não está separado por componente (comissão, taxas, frete, cupons): a Shopee entrega o valor
            final do pedido, e a divisão depende de conferir a documentação de cada campo.
          </p>
        </div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Todos — lado a lado                                                 */
/* ------------------------------------------------------------------ */

/**
 * O MERCADO LIVRE E A SHOPEE LADO A LADO (D-442): a receita soma, o resultado
 * de cada marketplace fica no dele. É o "Todos" de `/faturamento` e, desde a
 * D-480 (T8a), também a seção "Por marketplace" de `/central` — o mesmo bloco,
 * os mesmos números.
 */
export async function CorpoTodos({
  organizationId,
  recorte,
  range,
  leiturasDoMl,
}: {
  organizationId: string;
  recorte: RecorteDeFaturamento;
  range: { from: string; to: string };
  /**
   * D-610: as leituras do Mercado Livre que quem chama JÁ fez com os MESMOS
   * argumentos (o período `range`, sem conta; com ou sem detalhe, que o
   * `resumo` e a `margem_minima` são os mesmos — a `/central` lê com detalhe,
   * UX_SYSTEM §6). A `/central` as passa: lidas de novo aqui, eram uma
   * `get_faturamento` e uma `get_ads_overview` a mais por carga, em paralelo
   * com as outras (os timeouts de produção de 19/10). Sem elas, o bloco lê
   * sozinho, como no "Todos" de `/faturamento`.
   */
  leiturasDoMl?: { readonly faturamento: Promise<RespostaRpc>; readonly ads: Promise<RespostaRpc> };
}): Promise<ReactNode> {
  const supabase = await createClient();

  const [mlResult, shopeeResult, adsMlResult] = await Promise.all([
    leiturasDoMl?.faturamento ??
      supabase.rpc("get_faturamento", { p_date_from: range.from, p_date_to: range.to, p_detalhe: false }),
    supabase.rpc("get_shopee_faturamento", {
      p_organization_id: organizationId,
      p_date_from: range.from,
      p_date_to: range.to,
      p_account_ids: null,
    }),
    // D-498: o Product Ads do ML, só para a linha do lucro após imposto e Ads -- a mesma leitura da central.
    leiturasDoMl?.ads ?? supabase.rpc("get_ads_overview", { p_date_from: range.from, p_date_to: range.to }),
  ]);

  // Cada lado falha sozinho: o outro continua de pé, e o que falhou diz por quê.
  const ml = mlResult.error === null ? lerFaturamento(mlResult.data) : null;
  const shopee = shopeeResult.error === null ? separarLinhasShopee(shopeeResult.data).total : null;
  // O Ads que falhou não vira zero: o lucro do ML fica "—" (adsDoPeriodo sem leitura é nulo).
  const adsMl = adsMlResult.error === null ? lerVisaoAds(adsMlResult.data) : null;
  const linhas = linhasDaComparacao(ml, shopee, ml === null ? null : lucroDoMercadoLivre(ml, adsMl, range));
  const margemMinima = ml?.margemMinima;

  /*
    D-470: a falha de LEITURA de cada lado é erro, com a mensagem à parte; o
    "nenhuma loja real" da Shopee não é falha e continua nota. Antes a falha da
    Shopee saía como nota, no mesmo tom de "não há loja".
  */
  const acao: AcaoDoEstado = { href: hrefDeFaturamento(recorte), rotulo: TENTAR_DE_NOVO, mesmaTela: true };
  const falhaMl =
    mlResult.error !== null
      ? { titulo: "O Mercado Livre não carregou", detalhe: mlResult.error.message }
      : ml === null
        ? { titulo: "A resposta do Mercado Livre veio num formato que esta tela não reconhece", detalhe: undefined }
        : null;
  const falhaShopee = shopeeResult.error !== null ? { titulo: "A Shopee não carregou", detalhe: shopeeResult.error.message } : null;
  const motivoShopee =
    shopeeResult.error === null && shopee === null ? "nenhuma loja real com pedidos lidos — a loja de teste fica fora" : null;

  return (
    <>
      <p role="note" className="sb-an-nota">
        <strong>Sem total de resultado:</strong> o Mercado Livre e a Shopee descontam coisas diferentes antes do
        &ldquo;recebido&rdquo;, e somar os dois daria um número sem definição. A receita, que soma, está consolidada em{" "}
        <Link href={hrefDeVendas({ escopo: "todos", periodo: recorte.periodo, contas: null, metrica: "faturamento" })}>
          Vendas, todos os marketplaces
        </Link>
        .
      </p>

      <div style={{ marginTop: "var(--sb-space-3)" }}>
        <Panel
          title="Mercado Livre e Shopee lado a lado"
          subtitle="Cada coluna é a conta do próprio marketplace, sobre os pedidos cobertos dele."
        >
          <div className="sb-faturamento-tabela">
            <table className="sb-table sb-comparacao" aria-label="Faturamento por marketplace, lado a lado">
              <thead>
                <tr>
                  <th>Métrica</th>
                  <th className="sb-num">
                    <LinkDeFiltro href={hrefDeFaturamento(recorte, { escopo: "ml" })}>Mercado Livre</LinkDeFiltro>
                  </th>
                  <th className="sb-num">
                    <LinkDeFiltro href={hrefDeFaturamento(recorte, { escopo: "shopee" })}>Shopee</LinkDeFiltro>
                  </th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((linha) => (
                  <tr key={linha.rotulo}>
                    <td>
                      <strong>{linha.rotulo}</strong>
                    </td>
                    <td className="sb-num">
                      {linha.formato === "percentual" && linha.ml !== null && margemMinima !== undefined ? (
                        <StatePill tone={{ tom: tomDaMargem(linha.ml, margemMinima), label: formatPercent(linha.ml) }} />
                      ) : (
                        formatar(linha.ml, linha.formato)
                      )}
                      {linha.definicao !== null && <small className="sb-comparacao-def">{linha.definicao.ml}</small>}
                    </td>
                    <td className="sb-num">
                      {linha.formato === "percentual" && linha.shopee !== null && margemMinima !== undefined ? (
                        <StatePill
                          tone={{ tom: tomDaMargem(linha.shopee, margemMinima), label: formatPercent(linha.shopee) }}
                        />
                      ) : (
                        formatar(linha.shopee, linha.formato)
                      )}
                      {linha.definicao !== null && <small className="sb-comparacao-def">{linha.definicao.shopee}</small>}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Cobertura</strong>
                  </td>
                  <td className="sb-num" title="receita coberta ÷ receita bruta">
                    {formatPercent(participacao(ml?.resumo.receita_coberta ?? null, ml?.resumo.receita_bruta ?? null))}
                    <small className="sb-comparacao-def">da receita entra no resultado</small>
                  </td>
                  <td className="sb-num" title="receita coberta ÷ receita bruta">
                    {formatPercent(participacao(shopee?.receita_coberta ?? null, shopee?.receita_bruta ?? null))}
                    <small className="sb-comparacao-def">da receita entra no resultado</small>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {(falhaMl !== null || falhaShopee !== null || motivoShopee !== null) && (
            <div className="sb-panel-body">
              {falhaMl !== null && (
                <EstadoDaTela tipo="erro" titulo={falhaMl.titulo} detalhe={falhaMl.detalhe} acao={acao} />
              )}
              {falhaShopee !== null && (
                <EstadoDaTela tipo="erro" titulo={falhaShopee.titulo} detalhe={falhaShopee.detalhe} acao={acao} />
              )}
              {motivoShopee !== null && (
                <p role="note" className="sb-an-nota">
                  Shopee: {motivoShopee}.
                </p>
              )}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
