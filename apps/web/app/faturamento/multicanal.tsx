import { previousBusinessDateRange, toSalesMetricDate } from "@sb/domain";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { CarregandoBloco } from "../../components/carregando";
import { FilterMenu } from "../../components/filter-menu";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { SeletorDeMarketplace } from "../../components/seletor-marketplace";
import { StatePill } from "../../components/state-pill";
import { lerFaturamento, participacao, tomDaMargem, type SkuFaturamento } from "../../lib/faturamento";
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
} from "../../lib/faturamento-multicanal";
import { formatBusinessDate, formatCount, formatCurrency, formatDateTime, formatPercent } from "../../lib/format";
import { carregarLimites } from "../../lib/limites-central";
import { DEFAULT_PERIOD_DAYS, PERIOD_PRESETS, resolvePeriodRange } from "../../lib/period";
import { currentMembership } from "../../lib/request-membership";
import { createClient } from "../../lib/supabase/server";
import {
  HISTORICO_SHOPEE_DIAS,
  alternarConta,
  antesDoHistoricoShopee,
  hrefDeVendas,
  resolverContas,
  type ContaDoSeletor,
  type EscopoMulticanal,
  type Periodo,
} from "../../lib/vendas-multicanal";
import { AdsShopee } from "./ads-shopee";
import { BarrasDiarias } from "./barras-diarias";
import { Cascata } from "./cascata";
import { AVISO, ListaProdutos } from "./numeros";

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
    Os Ads CPC da loja (D-456, C-63), só no recorte Shopee. As duas leituras
    partem AGORA (`Promise.resolve` dispara o builder do supabase-js) e
    chegam por streaming numa seção própria, como o Mercado Ads na tela do ML:
    não esperam o faturamento, nem o faturamento as espera.
  */
  const adsDoPeriodo = {
    p_organization_id: organizationId,
    p_date_from: range.from,
    p_date_to: range.to,
    p_account_ids: selecionadas === null ? null : selecionadas.map((conta) => conta.account_id),
  };
  const leiturasAds =
    escopo === "shopee"
      ? {
          leitura: Promise.resolve(supabase.rpc("get_shopee_ads_overview", adsDoPeriodo)),
          diaria: Promise.resolve(supabase.rpc("get_shopee_ads_daily", adsDoPeriodo)),
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
              <form method="get" action="/faturamento" className="sb-periodo-form">
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
              </form>
            </FilterMenu>

            <Link className="sb-button" href={hrefDeVendas({ escopo, periodo, contas: selecionadas, metrica: "faturamento" })}>
              Dashboard de vendas
            </Link>
          </>
        }
      />

      {contasResult.error !== null && (
        <p role="alert" style={AVISO}>
          Não foi possível carregar as contas e lojas: o seletor e o filtro de lojas estão indisponíveis.
        </p>
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
        <p role="alert" style={AVISO}>
          Período personalizado inválido — mostrando os últimos {DEFAULT_PERIOD_DAYS} dias.
        </p>
      )}

      {/* O cabeçalho e os filtros saem antes; os números chegam por streaming, como na tela do ML. */}
      <Suspense fallback={<CarregandoBloco rotulo="faturamento" />}>{corpo}</Suspense>

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
      <p role="alert" style={AVISO}>
        Não foi possível carregar o faturamento da Shopee: {atualResult.error.message}
      </p>
    );
  }

  const { total, lojas } = separarLinhasShopee(atualResult.data);
  // Falhar o período anterior não pode parecer "o anterior não vendeu" (D-067).
  const totalAnterior = anteriorResult.error === null ? separarLinhasShopee(anteriorResult.data).total : null;
  const margemMinima = limites.margemMinima;
  const composicao =
    composicaoResult.error === null ? (composicaoResult.data.find((linha) => linha.nivel === "TOTAL") ?? null) : null;
  const cascata = total === null ? null : montarCascataShopee(composicao, total.custo_produtos, total.resultado_venda);

  return (
    <>
      {anteriorResult.error !== null && (
        <p role="alert" style={AVISO}>
          O período anterior não carregou — a comparação foi omitida, e isso não é zero.
        </p>
      )}

      <KpiStrip ancora cells={celulasShopee(total, totalAnterior, margemMinima)} />

      <p role="note" className="sb-an-nota">
        Resultado = o que a Shopee diz que a loja recebe (escrow) − o custo dos produtos. Não soma com o resultado do
        Mercado Livre, que desconta menos coisas —{" "}
        <Link href={hrefDeFaturamento(recorte, { escopo: "todos" })}>veja os dois lado a lado</Link>. A loja Shopee de
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
                <p role="alert" style={AVISO}>
                  Não foi possível carregar a composição do recebido: {composicaoResult.error.message}
                </p>
              )}

              {composicaoResult.error === null && cascata === null && (
                <p className="sb-empty">
                  Nenhum pedido coberto tem a composição do recebido lida neste período: sem cascata, em vez de uma de
                  zeros.
                </p>
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
                    margem após imposto {formatPercent(total.margem_apos_imposto)} · Ads e despesas fixas ficam fora
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
                {composicao !== null && (composicao.pedidos_com_ajuste ?? 0) > 0 && (
                  <li title="ajustes da Shopee depois do escrow">
                    <span className="sb-valores-rotulo">Ajustes depois do repasse</span>
                    <strong className="sb-valores-valor">{formatCurrency(composicao.ajustes)}</strong>
                    <span className="sb-valores-nota">
                      em {formatCount(composicao.pedidos_com_ajuste)} pedidos — o recebido acima não os inclui
                    </span>
                  </li>
                )}
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
              <p role="alert" style={AVISO}>
                Não foi possível carregar a série diária: {diarioResult.error.message}
              </p>
            ) : diarioResult.data.length === 0 ? (
              <p className="sb-empty">Nenhuma venda válida neste período.</p>
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
            <ProdutosShopee resultado={maisReceitaResult} modo="receita" margemMinima={margemMinima} />
          </Panel>
          <Panel
            title="Menor margem"
            subtitle={
              menorMargemResult.error === null
                ? notaDosProdutos(menorMargemResult.data, "margem")
                : "a leitura dos produtos falhou"
            }
          >
            <ProdutosShopee resultado={menorMargemResult} modo="margem" margemMinima={margemMinima} />
          </Panel>
        </div>
      )}

      <div style={{ marginTop: "var(--sb-space-3)" }}>
        <TabelaLojas total={total} lojas={lojas} margemMinima={margemMinima} />
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
}: {
  resultado: { data: SkuShopee[] | null; error: { message: string } | null };
  modo: "receita" | "margem";
  margemMinima: number;
}): ReactNode {
  if (resultado.error !== null) {
    return (
      <p role="alert" style={AVISO}>
        Não foi possível carregar os produtos: {resultado.error.message}
      </p>
    );
  }

  const linhas = (resultado.data ?? []).map(skuParaALista).filter((linha): linha is SkuFaturamento => linha !== null);

  return linhas.length === 0 ? (
    <p className="sb-empty">
      {modo === "receita" ? "Nenhum produto vinculado vendeu neste período." : "Nenhum produto com pedido coberto neste período."}
    </p>
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

function TabelaLojas({
  total,
  lojas,
  margemMinima,
}: {
  total: LinhaFaturamentoShopee | null;
  lojas: readonly LinhaFaturamentoShopee[];
  margemMinima: number;
}): ReactNode {
  return (
    <Panel
      title="Por loja"
      subtitle="Recebido, custo, resultado e margem sobre os pedidos cobertos de cada loja. O total soma só as lojas reais já lidas."
    >
      {lojas.length === 0 ? (
        <p className="sb-empty">Nenhuma loja Shopee neste recorte.</p>
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
          <p className="sb-empty">
            Nenhuma loja real com pedidos lidos neste recorte: não há o que cobrir. A loja de teste e a loja nunca lida ficam
            fora das somas.
          </p>
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

async function CorpoTodos({
  organizationId,
  recorte,
  range,
}: {
  organizationId: string;
  recorte: RecorteDeFaturamento;
  range: { from: string; to: string };
}): Promise<ReactNode> {
  const supabase = await createClient();

  const [mlResult, shopeeResult] = await Promise.all([
    supabase.rpc("get_faturamento", { p_date_from: range.from, p_date_to: range.to, p_detalhe: false }),
    supabase.rpc("get_shopee_faturamento", {
      p_organization_id: organizationId,
      p_date_from: range.from,
      p_date_to: range.to,
      p_account_ids: null,
    }),
  ]);

  // Cada lado falha sozinho: o outro continua de pé, e o que falhou diz por quê.
  const ml = mlResult.error === null ? lerFaturamento(mlResult.data) : null;
  const shopee = shopeeResult.error === null ? separarLinhasShopee(shopeeResult.data).total : null;
  const linhas = linhasDaComparacao(ml, shopee);
  const margemMinima = ml?.margemMinima;

  const motivoMl =
    mlResult.error !== null
      ? `não carregou: ${mlResult.error.message}`
      : ml === null
        ? "a resposta veio num formato que esta tela não reconhece"
        : null;
  const motivoShopee =
    shopeeResult.error !== null
      ? `não carregou: ${shopeeResult.error.message}`
      : shopee === null
        ? "nenhuma loja real com pedidos lidos — a loja de teste fica fora"
        : null;

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
                    <Link href={hrefDeFaturamento(recorte, { escopo: "ml" })}>Mercado Livre</Link>
                  </th>
                  <th className="sb-num">
                    <Link href={hrefDeFaturamento(recorte, { escopo: "shopee" })}>Shopee</Link>
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

          {(motivoMl !== null || motivoShopee !== null) && (
            <div className="sb-panel-body">
              {motivoMl !== null && (
                <p role="alert" style={AVISO}>
                  Mercado Livre: {motivoMl}.
                </p>
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
