import { previousBusinessDateRange, toSalesMetricDate } from "@sb/domain";
import Link from "next/link";
import type { ReactNode } from "react";

import { CarregandoSeODemorar } from "../../../components/carregando-link";
import { FilterMenu } from "../../../components/filter-menu";
import { KpiStrip, type KpiCellData } from "../../../components/kpi-strip";
import { EstadoDaTela, TENTAR_DE_NOVO, type AcaoDoEstado } from "../../../components/estado-da-tela";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { SavedFilters, type SavedFilter } from "../../../components/saved-filters";
import { SeletorDeMarketplace } from "../../../components/seletor-marketplace";
import { StatePill } from "../../../components/state-pill";
import { FormularioFiltro } from "../../../components/formulario-filtro";
import { LinkDeFiltro } from "../../../components/link-de-filtro";
import { formatBusinessDate, formatCount, formatCurrency, formatDateTime } from "../../../lib/format";
import { MARKETPLACE_ROTULO } from "../../../lib/marketplace";
import { DEFAULT_PERIOD_DAYS, PERIOD_PRESETS, resolvePeriodRange } from "../../../lib/period";
import { currentMembership } from "../../../lib/request-membership";
import { createClient } from "../../../lib/supabase/server";
import {
  HISTORICO_SHOPEE_DIAS,
  METRICAS_MULTICANAL,
  ROTULO_DO_ESCOPO,
  agruparLinhas,
  alternarConta,
  antesDoHistoricoShopee,
  hrefDeVendas,
  marketplacesDoEscopo,
  pontosDoTotal,
  resolverContas,
  resolverMetricaMulticanal,
  type ContaDoSeletor,
  type EscopoMulticanal,
  type LinhaDeVendas,
  type Periodo,
  type RecorteDeVendas,
} from "../../../lib/vendas-multicanal";
import {
  TAMANHO_DO_RANKING,
  ordemDoRanking,
  type LinhaDoRanking,
} from "../../../lib/vendas-por-sku";
import { LegendaDoGrafico, mostraComparacao, SalesChart } from "./sales-chart";

/**
 * `/vendas` COM MAIS DE UM MARKETPLACE (D-440, etapa T4 da frente multicanal).
 *
 * A mesma tela, com outro recorte: `marketplace=todos` (Mercado Livre e
 * Shopee) ou `marketplace=shopee`. Tudo vem do contrato C-53 (D-436) — o TOTAL
 * já somado no SQL, só com o que tem a mesma semântica (`docs/METRICS.md`
 * 5T): receita bruta, compras (o pack do ML e o pedido da Shopee), unidades e
 * o ticket recalculado. O "pedido" do ML e o "recebido" da Shopee não somam:
 * aparecem só na linha do marketplace deles. A loja de teste e a loja nunca
 * lida aparecem só por conta, fora das somas. **A tela não soma nada.**
 *
 * O que ainda é só do Mercado Livre — marca, "hoje", ranking de produtos,
 * cancelamento — fica na tela do ML, e esta diz isso em vez de mostrar um
 * número que mistura canais ou de calar a ausência.
 */

type Consulta = Record<string, string | string[] | undefined>;

/** O rótulo da conta no menu: o nome, o marketplace e, na de teste, a marca. */
function rotuloDaConta(conta: ContaDoSeletor): string {
  const marketplace = conta.marketplace === "ML" ? "Mercado Livre" : "Shopee";

  return `${conta.name} · ${marketplace}${conta.environment === "live" ? "" : " (teste)"}`;
}

function valorOuTraco(valor: number | null, formatar: (n: number) => string): string {
  return valor === null ? "—" : formatar(valor);
}

export async function VendasMulticanal({
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

  // As contas e os filtros salvos não dependem da organização (a RLS já os
  // restringe): saem junto com o membership.
  const [membership, contasResult, salvosResult] = await Promise.all([
    currentMembership(),
    supabase
      .from("marketplace_accounts")
      .select("account_id, marketplace, name, environment")
      .order("marketplace", { ascending: true })
      .order("name", { ascending: true }),
    supabase.from("saved_filters").select("id, name, params").eq("screen", "/vendas").order("name"),
  ]);

  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <>
        <PageTitle eyebrow="COMERCIAL / RESULTADOS" title="Dashboard de vendas" />
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </>
    );
  }

  const todasAsContas: ContaDoSeletor[] = contasResult.data ?? [];
  const { selecionadas, descartadas } = resolverContas(query.contas, todasAsContas, escopo);
  const metrica = resolverMetricaMulticanal(query.metric);
  const recorte: RecorteDeVendas = { escopo, periodo, contas: selecionadas, metrica: metrica.key };
  // D-470: "Tentar de novo" é a MESMA URL; "Limpar filtros" tira a escolha de contas (marketplace e período ficam).
  const tentarDeNovo: AcaoDoEstado = { href: hrefDeVendas(recorte), rotulo: TENTAR_DE_NOVO, mesmaTela: true };
  const limparFiltros: AcaoDoEstado | null =
    selecionadas === null ? null : { href: hrefDeVendas(recorte, { contas: null }), rotulo: "Limpar filtros", mesmaTela: true };

  const argumentos = {
    p_organization_id: organizationId,
    p_marketplaces: marketplacesDoEscopo(escopo),
    p_account_ids: selecionadas === null ? null : selecionadas.map((conta) => conta.account_id),
  };

  // As cinco leituras em paralelo: o período e o anterior, resumo e série, e
  // o ranking de produtos (C-59, D-444) na ordem da métrica do gráfico.
  const ordem = ordemDoRanking(metrica);
  const [atualResult, anteriorResult, diasResult, diasAnterioresResult, rankingResult] = await Promise.all([
    supabase.rpc("get_marketplace_sales_summary", { ...argumentos, p_date_from: range.from, p_date_to: range.to }),
    supabase.rpc("get_marketplace_sales_summary", {
      ...argumentos,
      p_date_from: anterior.from,
      p_date_to: anterior.to,
    }),
    supabase.rpc("get_marketplace_sales_daily", { ...argumentos, p_date_from: range.from, p_date_to: range.to }),
    supabase.rpc("get_marketplace_sales_daily", { ...argumentos, p_date_from: anterior.from, p_date_to: anterior.to }),
    supabase.rpc("get_marketplace_sku_sales", {
      ...argumentos,
      p_date_from: range.from,
      p_date_to: range.to,
      p_ordem: ordem,
      p_limit: TAMANHO_DO_RANKING,
      p_offset: 0,
    }),
  ]);

  // Falha em qualquer uma é erro dito, nunca "sem venda" (D-067). O ranking
  // falha sozinho, no painel dele: o resto da tela não depende dele.
  const erro = atualResult.error ?? anteriorResult.error ?? diasResult.error ?? diasAnterioresResult.error ?? null;

  const { total, grupos } = agruparLinhas(atualResult.data ?? []);
  const totalAnterior = agruparLinhas(anteriorResult.data ?? []).total;
  const serie = pontosDoTotal(diasResult.data ?? [], metrica);
  const serieAnterior = pontosDoTotal(diasAnterioresResult.data ?? [], metrica);

  const salvos: SavedFilter[] = (salvosResult.data ?? []).map((linha) => ({
    id: linha.id,
    name: linha.name,
    params: linha.params as Record<string, string>,
  }));

  const contasDoEscopo = todasAsContas.filter((conta) => escopo === "todos" || conta.marketplace === "SHOPEE");
  const rotuloContas =
    selecionadas === null
      ? "Todas as contas"
      : selecionadas.length === 1
        ? (selecionadas[0]?.name ?? "1 conta")
        : `${String(selecionadas.length)} contas`;
  const rotuloPeriodo = days === null ? "Período personalizado" : `Últimos ${String(days)} dias`;
  const temShopee = escopo === "shopee" || todasAsContas.some((conta) => conta.marketplace === "SHOPEE");
  const historicoCurto = temShopee && antesDoHistoricoShopee(anterior.from, hoje);

  const anteriorTem = totalAnterior !== null;
  const celulas: KpiCellData[] = [
    {
      metricId: "multicanal_receita_bruta",
      label: "Receita bruta",
      formula:
        "Produtos com o desconto do vendedor, sem frete, nos dois marketplaces; pedido Shopee de receita desconhecida fica fora",
      value: valorOuTraco(total?.receita_bruta ?? null, formatCurrency),
      previous: anteriorTem ? valorOuTraco(totalAnterior.receita_bruta, formatCurrency) : null,
      ...((total?.pedidos_sem_receita ?? 0) > 0
        ? { ressalva: `${formatCount(total?.pedidos_sem_receita ?? 0)} pedidos Shopee sem receita conhecida, fora da soma` }
        : {}),
    },
    {
      metricId: "multicanal_compras",
      label: "Compras",
      formula: "O pack do Mercado Livre e o pedido da Shopee — a compra do cliente nos dois",
      value: valorOuTraco(total?.compras ?? null, formatCount),
      previous: anteriorTem ? valorOuTraco(totalAnterior.compras, formatCount) : null,
    },
    {
      metricId: "multicanal_unidades",
      label: "Unidades vendidas",
      formula: "Unidades do Mercado Livre e da Shopee",
      value: valorOuTraco(total?.unidades ?? null, formatCount),
      previous: anteriorTem ? valorOuTraco(totalAnterior.unidades, formatCount) : null,
    },
    {
      metricId: "multicanal_ticket_medio",
      label: "Ticket médio",
      formula: "receita bruta ÷ compras de receita conhecida, recalculado sobre a soma — nunca média de médias",
      value: valorOuTraco(total?.ticket_medio ?? null, formatCurrency),
      previous: anteriorTem ? valorOuTraco(totalAnterior.ticket_medio, formatCurrency) : null,
    },
  ].map((celula) =>
    // Sem nada somável (só loja de teste, ou nenhuma lida), o "—" diz por quê.
    total === null ? { ...celula, ressalva: "nenhuma conta com venda somável neste recorte" } : celula,
  );

  const hrefPedidosShopee = hrefDeVendas(recorte, { escopo: "ml" }).replace(/^\/vendas/, "/vendas/shopee");

  return (
    <>
      <PageTitle
        eyebrow="COMERCIAL / RESULTADOS"
        title="Dashboard de vendas"
        subtitle={
          <>
            {ROTULO_DO_ESCOPO[escopo]}, {formatBusinessDate(range.from)} até {formatBusinessDate(range.to)} — comparado
            com {formatBusinessDate(anterior.from)} até {formatBusinessDate(anterior.to)}.
          </>
        }
        aside={
          <>
            <SeletorDeMarketplace
              ativo={escopo}
              contas={{
                ml: todasAsContas.filter((conta) => conta.marketplace === "ML").length,
                shopee: todasAsContas.filter((conta) => conta.marketplace === "SHOPEE").length,
              }}
              destinos={{
                todos: hrefDeVendas(recorte, { escopo: "todos" }),
                ml: hrefDeVendas(recorte, { escopo: "ml" }),
                shopee: hrefDeVendas(recorte, { escopo: "shopee" }),
              }}
            />

            {/*
              VÁRIAS CONTAS, uma por clique (D-440): cada opção liga ou desliga
              a conta no recorte, e a URL guarda todas num valor só
              (`contas=a,b`) — é o que um filtro salvo consegue guardar.
            */}
            {contasDoEscopo.length > 0 && (
              <FilterMenu
                nome="Contas"
                rotulo={rotuloContas}
                opcoes={[
                  { href: hrefDeVendas(recorte, { contas: null }), ativo: selecionadas === null, label: "Todas as contas" },
                  ...contasDoEscopo.map((conta) => {
                    const marcada = selecionadas?.some((c) => c.account_id === conta.account_id) ?? false;

                    return {
                      href: hrefDeVendas(recorte, { contas: alternarConta(selecionadas, conta) }),
                      ativo: marcada,
                      label: `${marcada ? "✓ " : ""}${rotuloDaConta(conta)}`,
                    };
                  }),
                ]}
              />
            )}

            <FilterMenu
              nome="Período"
              rotulo={rotuloPeriodo}
              opcoes={PERIOD_PRESETS.map((preset) => ({
                href: hrefDeVendas(recorte, { periodo: { days: preset } }),
                ativo: days === preset,
                label: `Últimos ${String(preset)} dias`,
              }))}
            >
              {/* Um GET nativo envia só os campos do formulário: os hidden mantêm o recorte. */}
              <FormularioFiltro action="/vendas" className="sb-periodo-form">
                <input type="hidden" name="marketplace" value={escopo} />
                {selecionadas !== null && (
                  <input type="hidden" name="contas" value={selecionadas.map((conta) => conta.account_id).join(",")} />
                )}
                {metrica.key !== "faturamento" && <input type="hidden" name="metric" value={metrica.key} />}
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

            <SavedFilters screen="/vendas" organizationId={organizationId} filters={salvos} />

            {total !== null && (
              <span
                style={{ fontSize: "0.6875rem", fontWeight: 700, color: "var(--sb-text-soft)", whiteSpace: "nowrap" }}
                title="A conta ou loja menos atualizada do recorte: o número vale até ela."
              >
                {total.ultima_atualizacao === null
                  ? "alguma conta nunca foi atualizada"
                  : `atualizado até ${formatDateTime(total.ultima_atualizacao)}`}
              </span>
            )}
          </>
        }
      />

      {(contasResult.error !== null || salvosResult.error !== null) && (
        <EstadoDaTela
          tipo="erro"
          titulo="Alguns filtros podem estar incompletos"
          descricao={`Não foi possível carregar ${
            contasResult.error !== null && salvosResult.error !== null
              ? "as contas e os filtros salvos"
              : contasResult.error !== null
                ? "as contas"
                : "os filtros salvos"
          }.`}
          detalhe={[contasResult.error?.message, salvosResult.error?.message]
            .filter((mensagem): mensagem is string => mensagem !== undefined)
            .join("; ")}
          acao={tentarDeNovo}
        />
      )}

      {descartadas > 0 && (
        <p role="note" className="sb-an-nota">
          {descartadas === 1
            ? "1 conta do link não está disponível para você neste recorte e ficou de fora."
            : `${String(descartadas)} contas do link não estão disponíveis para você neste recorte e ficaram de fora.`}
        </p>
      )}

      {invalidCustom && (
        <p role="status" className="sb-note sb-note-atencao" style={{ margin: "0 0 var(--sb-space-3)" }}>
          Período personalizado inválido — mostrando os últimos {DEFAULT_PERIOD_DAYS} dias.
        </p>
      )}

      {erro !== null && (
        <EstadoDaTela tipo="erro" titulo="Não foi possível carregar as vendas" detalhe={erro.message} acao={tentarDeNovo} />
      )}

      {erro === null && (
        <>
          <KpiStrip ancora cells={celulas} />

          {/*
            O QUE ESTE RECORTE AINDA NÃO TEM, dito em vez de calado: marca,
            "hoje" e cancelamento são do Mercado Livre até o cancelamento entrar
            no consolidado. O ranking de produtos chegou com o grão de SKU da
            Shopee (C-59, D-444).
          */}
          <p role="note" className="sb-an-nota">
            Marca, vendas de hoje e taxa de cancelamento ainda são só do Mercado Livre —{" "}
            <LinkDeFiltro href={hrefDeVendas(recorte, { escopo: "ml" })}>veja no recorte Mercado Livre</LinkDeFiltro>. A loja Shopee de
            teste nunca entra nas somas.
            {historicoCurto &&
              ` A Shopee guarda ${String(HISTORICO_SHOPEE_DIAS)} dias de histórico: a comparação com um período mais antigo subestima a Shopee.`}
          </p>

          <div style={{ marginTop: "var(--sb-space-3)" }}>
            <Panel
              title="Desempenho no período"
              aside={
                mostraComparacao(serie.pontos, serieAnterior.pontos, metrica) ? (
                  <LegendaDoGrafico previousRangeFrom={anterior.from} previousRangeTo={anterior.to} />
                ) : undefined
              }
              subtitle={
                <>
                  {formatBusinessDate(range.from)} a {formatBusinessDate(range.to)} · {ROTULO_DO_ESCOPO[escopo].toLowerCase()}
                  {serie.diasSemReceita > 0
                    ? ` · ${String(serie.diasSemReceita)} ${serie.diasSemReceita === 1 ? "dia" : "dias"} com receita desconhecida fora da linha`
                    : ""}
                </>
              }
            >
              <div className="sb-segmented" role="group" aria-label="Métrica do gráfico">
                {METRICAS_MULTICANAL.map((opcao) => (
                  <LinkDeFiltro
                    key={opcao.key}
                    href={hrefDeVendas(recorte, { metrica: opcao.key })}
                    aria-current={opcao.key === metrica.key ? "true" : undefined}
                  >
                    {opcao.label}
                    <CarregandoSeODemorar />
                  </LinkDeFiltro>
                ))}
              </div>

              {serie.pontos.length === 0 ? (
                <EstadoDaTela
                  tipo={limparFiltros === null ? "vazio" : "filtro"}
                  titulo="Nenhum dia com venda somável neste recorte"
                  descricao="A loja de teste e a loja nunca lida ficam fora das somas."
                  acao={limparFiltros ?? undefined}
                />
              ) : (
                <div style={{ padding: "var(--sb-space-2) var(--sb-space-3) var(--sb-space-3)" }}>
                  <SalesChart
                    points={serie.pontos}
                    previousPoints={serieAnterior.pontos}
                    metric={metrica}
                    rangeFrom={range.from}
                    rangeTo={range.to}
                    previousRangeFrom={anterior.from}
                  />
                </div>
              )}
            </Panel>
          </div>

          <div style={{ marginTop: "var(--sb-space-3)" }}>
            <Panel
              title="Por marketplace e conta"
              subtitle="A soma de cada marketplace vem do banco; pedidos do Mercado Livre e recebido da Shopee não somam entre canais e ficam na linha de cada um."
              aside={
                temShopee ? (
                  <Link href={hrefPedidosShopee} style={{ color: "var(--sb-secondary)", fontSize: "0.6875rem" }}>
                    Pedidos e lojas da Shopee →
                  </Link>
                ) : undefined
              }
            >
              {grupos.length === 0 ? (
                <EstadoDaTela
                  tipo={limparFiltros === null ? "vazio" : "filtro"}
                  titulo="Nenhuma conta neste recorte"
                  acao={limparFiltros ?? undefined}
                />
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="sb-table" aria-label="Vendas por marketplace e conta">
                    <thead>
                      <tr>
                        <th>Marketplace / conta</th>
                        <th className="sb-num">Receita bruta</th>
                        <th className="sb-num">Compras</th>
                        <th className="sb-num">Unidades</th>
                        <th className="sb-num">Ticket médio</th>
                        <th className="sb-num" title="Só do Mercado Livre: o pedido dele é uma linha de item">
                          Pedidos do ML
                        </th>
                        <th className="sb-num" title="Só da Shopee: o que ela diz que a loja recebe (escrow)">
                          Recebido (Shopee)
                        </th>
                        <th>Atualizado até</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grupos.flatMap((grupo) => [
                        <LinhaDaTabela
                          key={`mk-${grupo.marketplace}`}
                          linha={grupo.soma}
                          rotulo={MARKETPLACE_ROTULO[grupo.marketplace === "ML" ? "ml" : "shopee"]}
                          soma
                        />,
                        ...grupo.contas.map((conta) => (
                          <LinhaDaTabela key={conta.account_id ?? conta.account_name} linha={conta} rotulo={conta.account_name ?? "—"} />
                        )),
                      ])}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>

          <div style={{ marginTop: "var(--sb-space-3)" }}>
            <RankingDeProdutos
              erro={rankingResult.error}
              linhas={rankingResult.data ?? []}
              escopo={escopo}
              ordem={ordem}
              tentarDeNovo={tentarDeNovo}
              limparFiltros={limparFiltros}
            />
          </div>
        </>
      )}
    </>
  );
}

/**
 * Uma linha da tabela. A soma do marketplace em negrito; a conta abaixo. A
 * loja de teste leva a marca e "fora das somas"; a loja nunca lida tem tudo
 * NULO e mostra "—", nunca zero (D-067).
 */
function LinhaDaTabela({
  linha,
  rotulo,
  soma = false,
}: {
  linha: LinhaDeVendas | null;
  rotulo: string;
  soma?: boolean;
}): ReactNode {
  const teste = linha !== null && linha.environment !== null && linha.environment !== "live";
  const nuncaLida = linha !== null && linha.compras === null;
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
        {teste && (
          <span className="sb-an-meta">
            <StatePill tone={{ tom: "atencao", label: "Teste" }} /> fora das somas
          </span>
        )}
        {nuncaLida && <small className="sb-an-sub">pedidos ainda não lidos</small>}
      </td>
      <td className="sb-num" style={estilo}>
        {valorOuTraco(linha?.receita_bruta ?? null, formatCurrency)}
        {(linha?.pedidos_sem_receita ?? 0) > 0 && (
          <small className="sb-an-sub">{formatCount(linha?.pedidos_sem_receita ?? 0)} sem receita conhecida</small>
        )}
      </td>
      <td className="sb-num" style={estilo}>
        {valorOuTraco(linha?.compras ?? null, formatCount)}
      </td>
      <td className="sb-num" style={estilo}>
        {valorOuTraco(linha?.unidades ?? null, formatCount)}
      </td>
      <td className="sb-num" style={estilo}>
        {valorOuTraco(linha?.ticket_medio ?? null, formatCurrency)}
      </td>
      <td className="sb-num" style={estilo}>
        {valorOuTraco(linha?.pedidos_ml ?? null, formatCount)}
      </td>
      <td className="sb-num" style={estilo}>
        {valorOuTraco(linha?.recebido ?? null, formatCurrency)}
        {(linha?.pedidos_sem_recebido ?? 0) > 0 && (
          <small className="sb-an-sub">{formatCount(linha?.pedidos_sem_recebido ?? 0)} aguardando o financeiro</small>
        )}
      </td>
      <td style={estilo}>{linha?.ultima_atualizacao === null || linha === null ? "—" : formatDateTime(linha.ultima_atualizacao)}</td>
    </tr>
  );
}

/**
 * OS PRODUTOS QUE MAIS VENDERAM no recorte (D-444), do C-59: o total por SKU
 * já somado no SQL entre os marketplaces e, no "Todos", a parte de cada canal
 * ao lado. Diferente do ranking do ML, o que foi vendido SEM produto vinculado
 * aparece — marcado, sem link — porque é venda que existe e que nenhum
 * produto do catálogo explica.
 */
function RankingDeProdutos({
  erro,
  linhas,
  escopo,
  ordem,
  tentarDeNovo,
  limparFiltros,
}: {
  erro: { message: string } | null;
  linhas: readonly LinhaDoRanking[];
  escopo: EscopoMulticanal;
  ordem: "receita" | "unidades";
  tentarDeNovo: AcaoDoEstado;
  limparFiltros: AcaoDoEstado | null;
}): ReactNode {
  const todos = escopo === "todos";
  const total = linhas[0]?.total_count ?? 0;
  const criterio = ordem === "receita" ? "receita bruta" : "unidades";

  return (
    <Panel
      title="Produtos que mais venderam"
      subtitle={`top ${String(linhas.length === 0 ? TAMANHO_DO_RANKING : linhas.length)} de ${formatCount(total)} por ${criterio} · ${ROTULO_DO_ESCOPO[escopo].toLowerCase()} · a loja Shopee de teste fica fora`}
      aside={
        <Link href="/curva-abc" style={{ color: "var(--sb-secondary)", fontSize: "0.6875rem" }}>
          Curva ABC →
        </Link>
      }
    >
      {erro !== null ? (
        <EstadoDaTela tipo="erro" titulo="Não foi possível carregar o ranking" detalhe={erro.message} acao={tentarDeNovo} />
      ) : linhas.length === 0 ? (
        <EstadoDaTela
          tipo={limparFiltros === null ? "vazio" : "filtro"}
          titulo="Nenhum produto com venda somável neste recorte"
          acao={limparFiltros ?? undefined}
        />
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="sb-table" aria-label="Produtos que mais venderam">
            <thead>
              <tr>
                <th>Produto</th>
                <th className="sb-num">Receita bruta</th>
                <th className="sb-num">Unidades</th>
                <th className="sb-num" title="O pack do Mercado Livre e o pedido da Shopee que contêm o produto">
                  Compras
                </th>
                {todos && (
                  <>
                    <th className="sb-num">Mercado Livre</th>
                    <th className="sb-num">Shopee</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {linhas.map((linha) => (
                <tr key={linha.sku_id ?? "sem-sku"}>
                  <td>
                    {linha.sku_id === null ? (
                      <>
                        <strong>Sem produto vinculado</strong>
                        <small className="sb-an-sub">
                          vendido por anúncio sem SKU · <Link href="/vinculacoes">vincular</Link>
                        </small>
                      </>
                    ) : (
                      <>
                        <Link className="sb-entity" href={`/skus/${linha.sku_id}`}>
                          {linha.sku_title ?? linha.sku ?? "—"}
                        </Link>
                        <small className="sb-an-sub sb-mono">SKU {linha.sku ?? "—"}</small>
                      </>
                    )}
                  </td>
                  <td className="sb-num">
                    {valorOuTraco(linha.receita_bruta, formatCurrency)}
                    {(linha.itens_shopee_sem_receita ?? 0) > 0 && (
                      <small className="sb-an-sub">
                        {formatCount(linha.itens_shopee_sem_receita)} itens Shopee sem receita conhecida
                      </small>
                    )}
                  </td>
                  <td className="sb-num">{formatCount(linha.unidades)}</td>
                  <td className="sb-num">{formatCount(linha.compras)}</td>
                  {todos && (
                    <>
                      <td className="sb-num" title="receita bruta · unidades no Mercado Livre">
                        {valorOuTraco(linha.receita_ml, formatCurrency)}
                        <small className="sb-an-sub">{valorOuTraco(linha.unidades_ml, formatCount)} un</small>
                      </td>
                      <td className="sb-num" title="receita bruta · unidades na Shopee">
                        {valorOuTraco(linha.receita_shopee, formatCurrency)}
                        <small className="sb-an-sub">{valorOuTraco(linha.unidades_shopee, formatCount)} un</small>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
