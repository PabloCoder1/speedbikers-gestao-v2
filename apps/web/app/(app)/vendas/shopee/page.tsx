/*
 * DESVIO DE DESENHO (formato de docs/DESIGN_IMPLEMENTATION.md):
 * **Superfície:** `/vendas/shopee` · **Figma:** não há frame para a Shopee ·
 * **V3 real:** vendas das lojas Shopee por loja e a lista de pedidos com o SKU
 * gravado (D-430) · **Decisão:** compor com o Design Contract e os componentes
 * que `/vendas` e `/anuncios/shopee` já usam (PageTitle, Panel, FilterMenu,
 * StatePill, `.sb-table` e as classes `.sb-an-*`), sem forma nova; o id da
 * métrica mora sob o rótulo da coluna (`.sb-sync-metric-id`, a forma que
 * `/sincronizacao` já usa para isso) · **Motivo:** escopo enxuto — o Figma não
 * desenhou o segundo canal.
 */
import { toSalesMetricDate } from "@sb/domain";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { CarregandoBloco } from "../../../../components/carregando";
import { FilterMenu } from "../../../../components/filter-menu";
import { PageTitle } from "../../../../components/page-title";
import { Panel } from "../../../../components/panel";
import { SeletorDeMarketplace } from "../../../../components/seletor-marketplace";
import { StatePill } from "../../../../components/state-pill";
import { FormularioFiltro } from "../../../../components/formulario-filtro";
import { LinkDeFiltro } from "../../../../components/link-de-filtro";
import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../../components/estado-da-tela";
import { formatBusinessDate, formatCount, formatCurrency, formatDateTime } from "../../../../lib/format";
import { pageNumbers } from "../../../../lib/listings-dashboard";
import { contarContasMl } from "../../../../lib/marketplace";
import { DEFAULT_PERIOD_DAYS, PERIOD_PRESETS } from "../../../../lib/period";
import { formatAge } from "../../../../lib/relative-time";
import { currentMembership } from "../../../../lib/request-membership";
import { isShopeeSchemaMissing } from "../../../../lib/shopee-listings";
import {
  SHOPEE_ORDERS_PAGE_SIZE,
  SHOPEE_SALES_METRICS,
  SHOPEE_SITUACOES,
  buildShopeeSalesHref,
  lojaDeTesteShopee,
  nomeDaLojaShopee,
  origemDoSkuShopee,
  parseShopeeOrderItems,
  resolveShopeeSalesFilters,
  shopeeSituacao,
  summarizeShopeeOrdersWindow,
} from "../../../../lib/shopee-sales";
import { createClient } from "../../../../lib/supabase/server";
import { hrefDeVendas, type RecorteDeVendas } from "../../../../lib/vendas-multicanal";

import { DEVOLUCOES_A_VISTA, DevolucoesShopee } from "./devolucoes";

export const metadata = { title: "Vendas da Shopee — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de apps/web/app/(app)/vendas/page.tsx.
export const dynamic = "force-dynamic";

/**
 * Vendas da Shopee (D-430, fatia 6a da trilha Shopee).
 *
 * A Shopee entra nos relatórios como CANAL PRÓPRIO: duas RPCs só dela, e nada
 * do Mercado Livre muda — `/vendas`, `/faturamento`, a Central e o ranking
 * continuam lendo `daily_*_metrics`, e esta tela só ganhou um link de lá.
 *
 * - **Por loja** (`get_shopee_sales_by_shop`): uma linha por loja, inclusive a
 *   de sandbox, com contadores e somas feitos no SQL. A loja de TESTE é marcada
 *   e nunca entra em total da empresa — por isso a tela não soma linha nenhuma:
 *   um total, quando existir, nasce numa RPC que saiba separá-la.
 * - **Pedidos** (`get_shopee_orders`): paginada no SQL, com `total_count`, e o
 *   SKU que o worker gravou em cada item (manual, pelo SKU do anúncio, ou o SKU
 *   do próprio pedido).
 *
 * Ausência nunca vira zero (D-067): loja nunca lida mostra "—", receita
 * desconhecida (item de preço 0 sem o financeiro) é "—", e o recebido de um
 * pedido sem o financeiro lido é "aguardando o financeiro". A Shopee é lida
 * pelo worker, de hora em hora; esta tela nunca a chama.
 */


const SUBTITULO_GERAL = (
  <>
    Pedidos das lojas Shopee, lidos de hora em hora. As vendas do Mercado Livre estão no{" "}
    <Link href="/vendas">Dashboard de vendas</Link>.
  </>
);

/** A tela sem o que listar: o cabeçalho e um painel com o motivo. */
function SemVendas({ children }: { children: ReactNode }): ReactNode {
  return (
    <>
      <PageTitle eyebrow="COMERCIAL / RESULTADOS" title="Vendas da Shopee" subtitle={SUBTITULO_GERAL} />
      <div className="sb-an-lista">
        <Panel title="Pedidos">{children}</Panel>
      </div>
    </>
  );
}

/** O rótulo da coluna com o id da definição embaixo — a rastreabilidade do número. */
function ColunaDaMetrica({ metrica }: { metrica: { id: string; rotulo: string; formula: string } }): ReactNode {
  return (
    <th className="sb-num" title={metrica.formula}>
      {metrica.rotulo}
      <code className="sb-sync-metric-id">{metrica.id}</code>
    </th>
  );
}

export default async function VendasShopeePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();

  // As lojas não dependem da organização (a RLS já as restringe): saem junto
  // com o membership, como em `/anuncios/shopee`.
  const [membership, lojasResult, contasMl] = await Promise.all([
    currentMembership(),
    supabase
      .from("shopee_shops")
      .select("id, organization_id, shop_name, shop_id, environment, status")
      .order("connected_at", { ascending: true }),
    // D-431: só o NÚMERO de contas do Mercado Livre, para o seletor de
    // marketplace oferecer a volta a `/vendas`.
    contarContasMl(supabase),
  ]);

  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <SemVendas>
        <EstadoDaTela tipo="permissao" titulo="Sua conta não está associada a nenhuma organização." />
      </SemVendas>
    );
  }

  if (lojasResult.error !== null) {
    return (
      <SemVendas>
        {isShopeeSchemaMissing(lojasResult.error) ? (
          <EstadoDaTela tipo="vazio" titulo="As vendas da Shopee chegam com a próxima atualização do banco." />
        ) : (
          <EstadoDaTela
            tipo="erro"
            titulo="Não foi possível ler as lojas Shopee."
            descricao="A leitura falhou neste carregamento."
            detalhe={lojasResult.error.message}
          />
        )}
      </SemVendas>
    );
  }

  const lojas = lojasResult.data.filter((loja) => loja.organization_id === organizationId);

  if (lojas.length === 0) {
    return (
      <SemVendas>
        <EstadoDaTela
          tipo="vazio"
          titulo="Nenhuma loja Shopee conectada."
          descricao="Conecte a loja em Contas; os pedidos são lidos de hora em hora depois da conexão."
          acao={{ href: "/contas", rotulo: "Conectar loja em Contas" }}
        />
      </SemVendas>
    );
  }

  const agora = new Date();
  const { filters, invalidCustom } = resolveShopeeSalesFilters(
    query,
    lojas.map((loja) => loja.id),
    toSalesMetricDate(agora),
  );
  const situacaoAtiva = SHOPEE_SITUACOES.find((situacao) => situacao.slug === filters.situacao) ?? null;
  const lojaAtiva = lojas.find((loja) => loja.id === filters.loja) ?? null;
  const nomePorId = new Map(lojas.map((loja) => [loja.id, nomeDaLojaShopee(loja)]));

  /*
    Duas leituras em paralelo. O painel por loja conta o PERÍODO inteiro, sem a
    loja nem a situação: cada linha já é uma loja, e a situação é o que separa
    as somas (válidos) dos contadores (cancelados) — filtrá-lo por ela daria
    zero ou o próprio número.
  */
  /*
    AS DEVOLUÇÕES (D-460, C-62): partem AGORA, junto com as duas de baixo
    (`Promise.resolve` dispara o builder do supabase-js), e chegam por
    streaming num painel próprio. Recortam pela loja escolhida, como a lista;
    a situação do PEDIDO não se aplica a elas.
  */
  const doPeriodoDevolucoes = {
    p_organization_id: organizationId,
    p_date_from: filters.range.from,
    p_date_to: filters.range.to,
    p_account_ids: filters.loja === null ? null : [filters.loja],
  };
  const resumoDevolucoes = Promise.resolve(supabase.rpc("get_shopee_returns_summary", doPeriodoDevolucoes));
  const listaDevolucoes = Promise.resolve(
    supabase.rpc("get_shopee_returns", { ...doPeriodoDevolucoes, p_limit: DEVOLUCOES_A_VISTA }),
  );

  const [porLoja, pedidos] = await Promise.all([
    supabase.rpc("get_shopee_sales_by_shop", {
      p_organization_id: organizationId,
      p_date_from: filters.range.from,
      p_date_to: filters.range.to,
    }),
    supabase.rpc("get_shopee_orders", {
      p_organization_id: organizationId,
      p_date_from: filters.range.from,
      p_date_to: filters.range.to,
      p_shopee_shop_id: filters.loja,
      p_situacao: situacaoAtiva?.codigo ?? null,
      /*
        D-476: o pedido que a Busca Universal abriu. SÓ vai quando há pedido: o
        PostgREST escolhe a função pelos NOMES dos argumentos, e até a migration
        20261015110000 a de produção não tem `p_order_sn` — mandá-lo nulo
        derrubaria a tela inteira para todo mundo na janela entre a web e o banco.
      */
      ...(filters.pedido === null ? {} : { p_order_sn: filters.pedido }),
      p_limit: SHOPEE_ORDERS_PAGE_SIZE,
      p_offset: (filters.pagina - 1) * SHOPEE_ORDERS_PAGE_SIZE,
    }),
  ]);

  // As RPCs ausentes (banco anterior a 20261014150000): a novidade ainda não
  // chegou, não é erro — a mesma estratégia de `/anuncios/shopee`.
  if (isShopeeSchemaMissing(porLoja.error) || isShopeeSchemaMissing(pedidos.error)) {
    return (
      <SemVendas>
        <EstadoDaTela tipo="vazio" titulo="As vendas da Shopee chegam com a próxima atualização do banco." />
      </SemVendas>
    );
  }

  const linhasPorLoja = porLoja.error === null ? porLoja.data : null;
  const rows = pedidos.data ?? [];
  // `total_count` vem repetido em toda linha (window function); zero linhas é
  // zero no conjunto filtrado.
  const totalCount = rows[0]?.total_count ?? 0;
  const janela = summarizeShopeeOrdersWindow(filters.pagina, totalCount, rows.length);
  const alemDoFim = pedidos.error === null && rows.length === 0 && filters.pagina > 1;

  /*
    O ESCOPO da lista (a loja escolhida, ou todas) visto pelo painel: se nenhuma
    loja dele foi lida ainda, "nenhum pedido" afirmaria um período vazio que
    ninguém olhou. Filtrar linhas aqui não é somar — é escolher quais lojas.
  */
  const escopo =
    linhasPorLoja === null
      ? null
      : linhasPorLoja.filter((linha) => filters.loja === null || linha.shopee_shop_id === filters.loja);
  const escopoNuncaLido = escopo !== null && escopo.length > 0 && escopo.every((linha) => linha.ultima_leitura === null);
  // A leitura de hora em hora só visita loja CONECTADA (`triggerShopeeOrdersSync`).
  const leituraParada =
    escopo !== null && escopo.length > 0 && escopo.every((linha) => linha.connection_status !== "CONNECTED");

  const de = formatBusinessDate(filters.range.from);
  const ate = formatBusinessDate(filters.range.to);
  const periodoLabel = filters.days === null ? "Período personalizado" : `Últimos ${String(filters.days)} dias`;
  // O caminho de volta leva o período junto, como o link de lá traz o de lá.
  const hrefVendas = buildShopeeSalesHref(filters, { loja: null, situacao: null, pedido: null }).replace(
    /^\/vendas\/shopee/,
    "/vendas",
  );
  // O mesmo período, para o resumo da Shopee e o consolidado (D-440); loja e situação ficam aqui.
  const recorteDaVolta: RecorteDeVendas = {
    escopo: "shopee",
    periodo: filters.days === null ? { from: filters.range.from, to: filters.range.to } : { days: filters.days },
    contas: null,
    metrica: "faturamento",
  };

  const chips: { rotulo: string; href: string }[] = [
    ...(lojaAtiva === null ? [] : [{ rotulo: nomeDaLojaShopee(lojaAtiva), href: buildShopeeSalesHref(filters, { loja: null }) }]),
    ...(situacaoAtiva === null
      ? []
      : [{ rotulo: situacaoAtiva.plural, href: buildShopeeSalesHref(filters, { situacao: null }) }]),
    ...(filters.pedido === null
      ? []
      : [{ rotulo: `Pedido ${filters.pedido}`, href: buildShopeeSalesHref(filters, { pedido: null }) }]),
  ];
  const limpar = buildShopeeSalesHref(filters, { loja: null, situacao: null, pedido: null });

  return (
    <>
      <PageTitle
        eyebrow="COMERCIAL / RESULTADOS"
        title="Vendas da Shopee"
        subtitle={
          <>
            Pedidos das lojas Shopee de {de} até {ate}, pelo dia da criação do pedido em São Paulo, lidos de hora em
            hora. Venda válida é o pedido pago, fora de não pago, cancelado e em cancelamento.
          </>
        }
        aside={
          <>
            {/* O marketplace primeiro, como em `/vendas` (D-431): a volta leva
                só o período — loja e situação são da Shopee. */}
            <SeletorDeMarketplace
              ativo="shopee"
              contas={{ ml: contasMl, shopee: lojas.length }}
              destinos={{
                ml: hrefVendas,
                // D-440: o resumo da Shopee e o consolidado moram em `/vendas`;
                // esta tela é o detalhe dos pedidos e das lojas.
                shopee: hrefDeVendas(recorteDaVolta, { escopo: "shopee" }),
                todos: hrefDeVendas(recorteDaVolta, { escopo: "todos" }),
              }}
            />

            {/* Todo o recorte vive na URL, nunca em estado React — link
                compartilhável e voltar do navegador, como em `/vendas`. */}
            <FilterMenu
              rotulo={lojaAtiva === null ? "Todas as lojas" : nomeDaLojaShopee(lojaAtiva)}
              opcoes={[
                { href: buildShopeeSalesHref(filters, { loja: null }), ativo: lojaAtiva === null, label: "Todas as lojas" },
                ...lojas.map((loja) => ({
                  href: buildShopeeSalesHref(filters, { loja: loja.id }),
                  ativo: lojaAtiva?.id === loja.id,
                  label: lojaDeTesteShopee(loja.environment) ? `${nomeDaLojaShopee(loja)} (teste)` : nomeDaLojaShopee(loja),
                })),
              ]}
            />

            <FilterMenu
              rotulo={periodoLabel}
              opcoes={PERIOD_PRESETS.map((preset) => ({
                href: buildShopeeSalesHref(filters, { days: preset }),
                ativo: filters.days === preset,
                label: `Últimos ${String(preset)} dias`,
              }))}
            >
              {/* O período personalizado de `/vendas` (D-431): a URL já o
                  aceitava (`from`/`to`), faltava o formulário. Um GET nativo
                  envia só os campos do formulário — sem os hidden, aplicar o
                  período descartaria a loja e a situação. */}
              <FormularioFiltro action="/vendas/shopee" className="sb-periodo-form">
                {filters.loja !== null && <input type="hidden" name="loja" value={filters.loja} />}
                {filters.situacao !== null && <input type="hidden" name="situacao" value={filters.situacao} />}
                {filters.pedido !== null && <input type="hidden" name="pedido" value={filters.pedido} />}
                <input
                  type="date"
                  name="from"
                  defaultValue={filters.days === null ? filters.range.from : undefined}
                  aria-label="Data inicial"
                  className="sb-input"
                />
                <input
                  type="date"
                  name="to"
                  defaultValue={filters.days === null ? filters.range.to : undefined}
                  aria-label="Data final"
                  className="sb-input"
                />
                <button type="submit" className="sb-button sb-button-primary">
                  Aplicar período
                </button>
              </FormularioFiltro>
            </FilterMenu>
          </>
        }
      />

      {invalidCustom && (
        <p role="status" className="sb-note sb-note-atencao" style={{ margin: "0 0 var(--sb-space-3)" }}>
          Período personalizado inválido — mostrando os últimos {DEFAULT_PERIOD_DAYS} dias.
        </p>
      )}

      <div className="sb-an-lista">
        <Panel
          title="Por loja"
          subtitle={`${de} a ${ate} · uma linha por loja · cancelados e não pagos ficam fora das somas`}
        >
          {porLoja.error !== null ? (
            <EstadoDaTela
              tipo="erro"
              titulo="Não foi possível carregar as vendas por loja."
              descricao="A leitura falhou neste carregamento."
              detalhe={porLoja.error.message}
            />
          ) : porLoja.data.length === 0 ? (
            <EstadoDaTela tipo="vazio" titulo="Nenhuma loja Shopee para mostrar." />
          ) : (
            <div className="sb-an-rolagem">
              {/*
                SEM LINHA DE TOTAL, de propósito: somar as lojas aqui seria
                agregação em JavaScript, e misturaria a loja de teste com as de
                verdade. Um total da empresa nasce numa RPC que saiba separá-la.
              */}
              <table className="sb-table sb-an-tabela sb-vendas-lojas" aria-label="Vendas da Shopee por loja">
                <thead>
                  <tr>
                    <th>Loja</th>
                    <ColunaDaMetrica metrica={SHOPEE_SALES_METRICS.pedidos} />
                    <ColunaDaMetrica metrica={SHOPEE_SALES_METRICS.unidades} />
                    <ColunaDaMetrica metrica={SHOPEE_SALES_METRICS.receitaBruta} />
                    <ColunaDaMetrica metrica={SHOPEE_SALES_METRICS.recebido} />
                    <th className="sb-num" title="Pedidos cancelados ou em cancelamento na Shopee, no período.">
                      Cancelados
                    </th>
                    <th
                      className="sb-num"
                      title="Pedidos válidos com devolução registrada — a devolução chega com o financeiro do pedido."
                    >
                      Devoluções
                    </th>
                    <th className="sb-num" title="Pedidos válidos com pelo menos um item sem SKU gravado.">
                      Com item sem SKU
                    </th>
                    <th title="Até onde os pedidos da loja já foram lidos na Shopee; a leitura roda de hora em hora.">
                      Última leitura
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {porLoja.data.map((linha) => {
                    const nome = nomePorId.get(linha.shopee_shop_id) ?? linha.shop_name ?? "Loja Shopee";
                    const teste = lojaDeTesteShopee(linha.environment);
                    const conectada = linha.connection_status === "CONNECTED";
                    // Pedidos NUNCA lidos: "0 pedidos" afirmaria uma loja sem
                    // venda que ninguém olhou. Os números ficam "—".
                    const nuncaLida = linha.ultima_leitura === null;
                    const valor = (texto: string): string => (nuncaLida ? "—" : texto);

                    return (
                      <tr key={linha.shopee_shop_id}>
                        <td className="sb-an-produto">
                          <span className="sb-an-produto-texto">
                            <span className="sb-an-titulo">{nome}</span>
                            <span className="sb-an-meta">
                              {teste && <StatePill tone={{ tom: "atencao", label: "Teste" }} />}
                              {!conectada && <span>conexão com erro</span>}
                              <LinkDeFiltro href={buildShopeeSalesHref(filters, { loja: linha.shopee_shop_id })}>ver pedidos</LinkDeFiltro>
                            </span>
                            {teste && (
                              <span className="sb-an-meta">loja de teste: não entra em nenhum total da empresa</span>
                            )}
                          </span>
                        </td>
                        <td className="sb-num" data-label="Pedidos">
                          {valor(formatCount(linha.pedidos))}
                        </td>
                        <td className="sb-num" data-label="Unidades">
                          {valor(formatCount(linha.unidades))}
                        </td>
                        <td className="sb-num" data-label="Receita bruta">
                          {valor(formatCurrency(linha.receita_bruta))}
                          {!nuncaLida && linha.pedidos_sem_receita > 0 && (
                            <small className="sb-an-sub">{formatCount(linha.pedidos_sem_receita)} sem receita conhecida</small>
                          )}
                        </td>
                        <td className="sb-num" data-label="Recebido">
                          {valor(formatCurrency(linha.recebido))}
                          {!nuncaLida && linha.pedidos_sem_recebido > 0 && (
                            <small className="sb-an-sub">
                              {formatCount(linha.pedidos_sem_recebido)} aguardando o financeiro
                            </small>
                          )}
                        </td>
                        <td className="sb-num" data-label="Cancelados">
                          {valor(formatCount(linha.cancelados))}
                        </td>
                        <td className="sb-num" data-label="Devoluções">
                          {valor(formatCount(linha.com_devolucao))}
                        </td>
                        <td className="sb-num" data-label="Com item sem SKU">
                          {valor(formatCount(linha.pedidos_sem_sku))}
                        </td>
                        <td data-label="Última leitura">
                          {linha.ultima_leitura === null ? (
                            <>
                              pedidos ainda não lidos
                              <small className="sb-an-sub">
                                {conectada
                                  ? "a leitura é de hora em hora"
                                  : "a leitura está parada até a loja ser reconectada"}
                              </small>
                            </>
                          ) : (
                            <>
                              {formatAge(linha.ultima_leitura, agora) ?? formatDateTime(linha.ultima_leitura)}
                              <small className="sb-an-sub">
                                {conectada ? "a leitura é de hora em hora" : "a leitura está parada: conexão com erro"}
                              </small>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {linhasPorLoja !== null && linhasPorLoja.some((linha) => linha.connection_status !== "CONNECTED") && (
            <p role="note" className="sb-an-nota">
              Loja com a conexão em erro não é relida até ser reconectada em <Link href="/contas">Contas</Link>.
            </p>
          )}
        </Panel>
      </div>

      {/* Decisão do dono (15/10): as devoluções logo depois do "Por loja", antes dos pedidos. */}
      <section id="devolucoes" className="sb-campanhas-ml" aria-label="Devoluções da Shopee">
        <Suspense
          fallback={
            <Panel title="Devoluções" subtitle="Carregando as devoluções do período">
              <CarregandoBloco rotulo="devoluções da Shopee" />
            </Panel>
          }
        >
          <DevolucoesShopee
            resumo={resumoDevolucoes}
            lista={listaDevolucoes}
            tentarDeNovo={buildShopeeSalesHref(filters, { pagina: filters.pagina })}
            periodo={`${de} a ${ate}${lojaAtiva === null ? "" : ` · ${nomeDaLojaShopee(lojaAtiva)}`}`}
          />
        </Suspense>
      </section>

      <div className="sb-an-lista">
        <Panel
          title="Pedidos"
          subtitle={pedidos.error === null && !alemDoFim ? janela.label : undefined}
          aside={
            <FilterMenu
              rotulo={situacaoAtiva?.plural ?? "Todas as situações"}
              opcoes={[
                {
                  href: buildShopeeSalesHref(filters, { situacao: null }),
                  ativo: situacaoAtiva === null,
                  label: "Todas as situações",
                },
                ...SHOPEE_SITUACOES.map((situacao) => ({
                  href: buildShopeeSalesHref(filters, { situacao: situacao.slug }),
                  ativo: situacaoAtiva?.slug === situacao.slug,
                  label: situacao.plural,
                })),
              ]}
            />
          }
        >
          {chips.length > 0 && (
            <div className="sb-an-chips" aria-label="Filtros ativos">
              <span className="sb-an-chips-rotulo">Filtros ativos:</span>
              {chips.map((chip) => (
                <LinkDeFiltro key={chip.rotulo} className="sb-an-chip" href={chip.href} aria-label={`Tirar o filtro ${chip.rotulo}`}>
                  {chip.rotulo}
                  <span aria-hidden="true">×</span>
                </LinkDeFiltro>
              ))}
              <LinkDeFiltro className="sb-text-button sb-an-limpar" href={limpar}>
                Limpar filtros
              </LinkDeFiltro>
            </div>
          )}

          {pedidos.error === null && rows.length > 0 && (
            <p role="note" className="sb-an-nota">
              Cancelados e não pagos aparecem na lista e ficam fora das somas do painel por loja. A devolução e o
              recebido chegam com o financeiro do pedido, que a Shopee só fecha quando o pedido completa.
            </p>
          )}

          {pedidos.error !== null && (
            <EstadoDaTela
              tipo="erro"
              titulo="Não foi possível carregar os pedidos da Shopee."
              descricao="A leitura falhou neste carregamento."
              detalhe={pedidos.error.message}
              acao={{
                href: buildShopeeSalesHref(filters, { pagina: filters.pagina }),
                rotulo: TENTAR_DE_NOVO,
                mesmaTela: true,
              }}
            />
          )}

          {pedidos.error === null &&
            rows.length === 0 &&
            (alemDoFim ? (
              <EstadoDaTela
                tipo="filtro"
                titulo="Esta página passou do fim da lista."
                acao={{ href: buildShopeeSalesHref(filters, { pagina: 1 }), rotulo: "Voltar à primeira página", mesmaTela: true }}
              />
            ) : escopoNuncaLido ? (
              <EstadoDaTela
                tipo="vazio"
                titulo="Os pedidos da Shopee ainda não foram lidos."
                descricao={
                  leituraParada
                    ? "A conexão da loja está com erro, e a leitura só roda com a loja conectada."
                    : "A primeira leitura acontece na próxima hora — os pedidos são lidos de hora em hora."
                }
                acao={leituraParada ? { href: "/contas", rotulo: "Reconectar em Contas" } : undefined}
              />
            ) : filters.pedido !== null ? (
              // D-476: o pedido que a busca abriu e não está neste recorte (outro dia, outra loja, outra situação).
              <EstadoDaTela
                tipo="filtro"
                titulo={`O pedido ${filters.pedido} não está neste recorte.`}
                descricao="Ele pode ser de outro período, de outra loja ou de outra situação."
                acao={{ href: limpar, rotulo: "Limpar filtros", mesmaTela: true }}
              />
            ) : situacaoAtiva !== null ? (
              <EstadoDaTela
                tipo="filtro"
                titulo="Nenhum pedido nesta situação no período."
                acao={{ href: limpar, rotulo: "Limpar filtros", mesmaTela: true }}
              />
            ) : (
              <EstadoDaTela
                tipo="vazio"
                titulo={lojaAtiva === null ? "Nenhum pedido da Shopee no período." : "Nenhum pedido desta loja no período."}
                descricao={`Nenhum pedido criado de ${de} até ${ate}; os pedidos são lidos de hora em hora.`}
              />
            ))}
          {pedidos.error === null && rows.length > 0 && (
            <div className="sb-an-rolagem">
              <table className="sb-table sb-an-tabela" aria-label="Pedidos da Shopee">
                <thead>
                  <tr>
                    <th title="Criação do pedido na Shopee, no horário de São Paulo">Data</th>
                    <th>Loja</th>
                    <th>Pedido</th>
                    <th title="Válida, cancelada ou não paga — e o status do pedido na Shopee">Situação</th>
                    <th title="Cada item com o SKU gravado na leitura do pedido e de onde ele veio">Itens</th>
                    <ColunaDaMetrica metrica={SHOPEE_SALES_METRICS.receitaBruta} />
                    <ColunaDaMetrica metrica={SHOPEE_SALES_METRICS.recebido} />
                    <th title="A devolução chega com o financeiro do pedido">Devolução</th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((pedido) => {
                    const situacao = shopeeSituacao(pedido.situacao);
                    const itens = parseShopeeOrderItems(pedido.itens);
                    const valida = pedido.situacao === "VALIDA";

                    return (
                      <tr key={`${pedido.shopee_shop_id}:${pedido.order_sn}`}>
                        <td data-label="Data">{formatDateTime(pedido.shopee_created_at)}</td>
                        <td data-label="Loja">
                          {nomePorId.get(pedido.shopee_shop_id) ?? pedido.shop_name ?? "—"}
                          {lojaDeTesteShopee(pedido.environment) && (
                            <span className="sb-an-sub">
                              <StatePill tone={{ tom: "atencao", label: "Teste" }} />
                            </span>
                          )}
                        </td>
                        <td data-label="Pedido">
                          <span className="sb-mono">{pedido.order_sn}</span>
                        </td>
                        <td data-label="Situação">
                          {situacao === null ? (
                            pedido.situacao
                          ) : (
                            <span title={situacao.criterio}>
                              <StatePill tone={{ tom: situacao.tom, label: situacao.rotulo }} />
                            </span>
                          )}
                          <small className="sb-an-sub sb-mono" title="O status do pedido na Shopee">
                            {pedido.order_status}
                          </small>
                        </td>
                        {/* Sem `data-label`: no celular a célula ocupa a largura
                            do cartão, como o anúncio em `/anuncios/shopee`. */}
                        <td className="sb-an-produto">
                          {itens.length === 0 ? (
                            <span className="sb-an-suave">itens ainda não lidos</span>
                          ) : (
                            <div style={{ display: "grid", gap: "0.5rem" }}>
                              {itens.map((item, indice) => (
                                <span key={`${String(item.itemId)}:${String(item.modelId)}:${String(indice)}`} className="sb-an-produto-texto">
                                  {item.nome === null ? (
                                    <span className="sb-an-titulo sb-an-suave">Nome não lido</span>
                                  ) : (
                                    <span className="sb-an-titulo">{item.nome}</span>
                                  )}
                                  <span className="sb-an-meta">
                                    {item.variacao !== null && <span>{item.variacao}</span>}
                                    <span>× {formatCount(item.quantidade)}</span>
                                    <span aria-hidden="true">·</span>
                                    {item.skuId !== null && item.sku !== null ? (
                                      <>
                                        <Link className="sb-mono" href={`/skus/${item.skuId}`}>
                                          {item.sku}
                                        </Link>
                                        <span>{origemDoSkuShopee(item.vinculoVia)}</span>
                                      </>
                                    ) : (
                                      <span>sem SKU</span>
                                    )}
                                  </span>
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        {/* Receita DESCONHECIDA é "—", nunca zero: um item de preço 0
                            (bundle) sem o financeiro lido não diz quanto o pedido vale. */}
                        <td className="sb-num" data-label="Receita bruta">
                          {pedido.receita_bruta === null ? (
                            <>
                              —<small className="sb-an-sub">sem receita conhecida</small>
                            </>
                          ) : (
                            <>
                              {formatCurrency(pedido.receita_bruta)}
                              {!pedido.financeiro_lido && <small className="sb-an-sub">pelos itens</small>}
                            </>
                          )}
                        </td>
                        <td className="sb-num" data-label="Recebido">
                          {pedido.financeiro_lido ? (
                            <>
                              {formatCurrency(pedido.recebido)}
                              {valida && pedido.order_status !== "COMPLETED" && (
                                <small className="sb-an-sub" title="O recebido muda até o pedido completar na Shopee.">
                                  provisório
                                </small>
                              )}
                            </>
                          ) : pedido.situacao === "NAO_PAGA" ? (
                            // Pedido não pago não tem financeiro para esperar.
                            "—"
                          ) : (
                            <span className="sb-an-suave">aguardando o financeiro</span>
                          )}
                        </td>
                        <td data-label="Devolução">
                          {!pedido.financeiro_lido ? (
                            <span title="A devolução chega com o financeiro do pedido, ainda não lido.">—</span>
                          ) : pedido.com_devolucao ? (
                            <StatePill tone={{ tom: "atencao", label: "Com devolução" }} />
                          ) : (
                            "não"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {pedidos.error === null && janela.totalPages > 1 && (
            <nav className="sb-an-paginacao" aria-label="Paginação dos pedidos da Shopee">
              <span className="sb-an-suave">{janela.label}</span>
              <div className="sb-an-paginas">
                {filters.pagina > 1 ? (
                  <LinkDeFiltro className="sb-button" href={buildShopeeSalesHref(filters, { pagina: filters.pagina - 1 })}>
                    ‹ Anterior
                  </LinkDeFiltro>
                ) : (
                  <span className="sb-button" aria-disabled="true">
                    ‹ Anterior
                  </span>
                )}
                {pageNumbers(filters.pagina, janela.totalPages).map((numeroDaPagina, indice) =>
                  numeroDaPagina === "…" ? (
                    <span key={`salto-${String(indice)}`} className="sb-an-salto" aria-hidden="true">
                      …
                    </span>
                  ) : (
                    <LinkDeFiltro
                      key={numeroDaPagina}
                      className={numeroDaPagina === filters.pagina ? "sb-an-pagina sb-an-pagina-atual" : "sb-an-pagina"}
                      href={buildShopeeSalesHref(filters, { pagina: numeroDaPagina })}
                      aria-current={numeroDaPagina === filters.pagina ? "page" : undefined}
                      aria-label={`Página ${String(numeroDaPagina)}`}
                    >
                      {formatCount(numeroDaPagina)}
                    </LinkDeFiltro>
                  ),
                )}
                {filters.pagina < janela.totalPages ? (
                  <LinkDeFiltro className="sb-button" href={buildShopeeSalesHref(filters, { pagina: filters.pagina + 1 })}>
                    Próxima ›
                  </LinkDeFiltro>
                ) : (
                  <span className="sb-button" aria-disabled="true">
                    Próxima ›
                  </span>
                )}
              </div>
            </nav>
          )}
        </Panel>
      </div>
    </>
  );
}
