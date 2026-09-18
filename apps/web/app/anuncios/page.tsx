import Link from "next/link";
import type { ReactNode } from "react";

import { FilterMenu } from "../../components/filter-menu";
import { Icone } from "../../components/icons";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { SavedFilters, type SavedFilter } from "../../components/saved-filters";
import { Shell } from "../../components/shell";
import { StatusPill } from "../../components/status-pill";
import { formatCount, formatCurrency, formatDateTime, formatPercent } from "../../lib/format";
import { monogramaDeProduto } from "../../lib/initials";
import { listingStatusLabel } from "../../lib/labels";
import {
  FULL_FILTERS,
  LINK_STATE_FILTERS,
  PAGE_SIZE,
  SOLD_FILTERS,
  STOCK_FILTERS,
  linkStateBadge,
  nextOrder,
  orderKey,
  orderParam,
  pageNumbers,
  resolveFullFilter,
  resolveLinkStateFilter,
  resolveOrder,
  resolvePage,
  resolveSoldFilter,
  resolveStatusFilter,
  resolveStockFilter,
  summarizeWindow,
  type ListingsOrder,
  type OrderColumn,
} from "../../lib/listings-dashboard";
import { PAGE_SIZES, buildFilterHref, resolvePageSize, type PageSize } from "../../lib/filters";
import { DEFAULT_PERIOD_DAYS, PERIOD_PRESETS, resolvePeriodDays } from "../../lib/period";
import { createClient } from "../../lib/supabase/server";
import { currentMembership } from "../../lib/request-membership";

import { InspecaoAnuncio } from "./inspecao-anuncio";
import { lastBusinessDays } from "../../lib/business-window";

export const metadata = { title: "Anúncios — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de apps/web/app/estoque/page.tsx.
export const dynamic = "force-dynamic";

/**
 * Dashboard de Anúncios (Fase 5C, D-138; composição do Figma em D-242;
 * ordenação, faixa numa consulta e foto do anúncio em 20260918150000).
 *
 * **Deixou de ser lista e passou a responder perguntas**, que é o que
 * `docs/PRODUCT_REQUIREMENTS.md` pede: quais anúncios existem, em qual conta,
 * com qual SKU, quais venderam, quais não têm vínculo.
 *
 * 🔴 **A versão anterior mostrava 1.000 de 5.085 anúncios, em silêncio.** Lia
 * `from("listings").select(...).order("title")` sem `.range()`, e o PostgREST
 * corta em `max_rows = 1000` devolvendo `error` NULO — sexta ocorrência da
 * classe de D-131. Agora o pivô, os filtros, a ORDEM e a contagem vivem no
 * Postgres (`get_listings_dashboard`) e a tela lê uma janela declarada,
 * exibindo sempre "N de M".
 *
 * ## A faixa de estados, e o que ela NÃO diz (D-242)
 *
 * Seis células, todas medidas: total, ativos, pausados, sem estoque, no Full
 * (D-243) e sem vínculo. **"Com queda" do frame ficou de fora** em vez de
 * virar número inventado — não há detecção de anomalia por anúncio, e "queda"
 * não tem entrada em `metric_definitions` (D-023).
 *
 * Até 18/09/2026 cada célula era uma chamada inteira da lista com
 * `p_limit = 1` — seis agregações de venda e visitas que as contagens não
 * usam, ~0,7 s de banco por visita. Agora é `get_listings_dashboard_counts`,
 * uma passada de 63 ms, com os predicados copiados da lista e presos a ela
 * pelo teste de integração "contagens = total_count da lista".
 */

interface DashboardRow {
  listing_id: string;
  item_id: string;
  title: string;
  status: string;
  price: number;
  available_quantity: number;
  synced_at: string;
  ml_account_id: string;
  account_label: string;
  sku_id: string | null;
  sku: string | null;
  link_state: string;
  units_sold: number;
  gross_revenue: number;
  visits: number | null;
  days_observed: number;
  conversion_rate: number | null;
  /** NULA sem snapshot de Full (D-243). */
  full_quantity: number | null;
  /** NULA até a próxima sincronização; AUSENTE com o banco anterior a 20260918150000. */
  thumbnail_url?: string | null;
  permalink?: string | null;
  total_count: number;
}

interface Filters {
  account: string | null;
  status: string | null;
  link: string;
  stock: string;
  full: string;
  /** 'all' | 'with' | 'without' — venda na janela (D-308, predicado de D-259). */
  sold: string;
  /** Dias da janela. Muda venda/visitas/conversão e o predicado `sold` (D-308). */
  days: number;
  search: string | null;
  order: ListingsOrder;
  pageSize: PageSize;
  page: number;
}

/**
 * Preserva as outras dimensões ao trocar uma — mesmo `buildHref` de
 * `/vendas`. Trocar de conta NÃO pode resetar o filtro de vínculo.
 *
 * Qualquer mudança de filtro, ordem ou tamanho volta para a página 1: manter
 * o offset seria mostrar "página 7 de 2", ou pior, uma página vazia que
 * parece "nenhum resultado".
 */
function buildHref(current: Filters, override: Partial<Filters>): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/anuncios",
    {
      conta: next.account,
      estado: next.status,
      // "all" e o default de cada eixo: fica fora da URL.
      vinculo: next.link === "all" ? null : next.link,
      estoque: next.stock === "all" ? null : next.stock,
      full: next.full === "all" ? null : next.full,
      venda: next.sold === "all" ? null : next.sold,
      // O padrão fica fora da URL: `/anuncios` continua sendo o endereço da
      // janela de 30 dias, por faturamento, 50 por página.
      dias: next.days === DEFAULT_PERIOD_DAYS ? null : String(next.days),
      busca: next.search,
      ordem: orderParam(next.order),
      tamanho: next.pageSize === PAGE_SIZE ? null : String(next.pageSize),
    },
    override.page === undefined ? 1 : next.page,
  );
}

const NEUTRO: Partial<Filters> = { status: null, link: "all", stock: "all", full: "all", sold: "all", search: null };

/** Cabeçalho que ordena: o link é o próximo estado, e `aria-sort` diz o atual. */
function Cabecalho({
  coluna,
  rotulo,
  filters,
  numerico = false,
  dica,
  ordena,
}: {
  coluna: OrderColumn;
  rotulo: string;
  filters: Filters;
  numerico?: boolean;
  dica?: string;
  /** Falso com o banco anterior a 20260918150000: o cabeçalho vira texto. */
  ordena: boolean;
}): ReactNode {
  const ativa = filters.order.column === coluna;
  const crescente = filters.order.direction === "asc";

  if (!ordena) {
    return (
      <th className={numerico ? "sb-num" : undefined} title={dica}>
        {rotulo}
      </th>
    );
  }

  return (
    <th
      className={numerico ? "sb-num" : undefined}
      aria-sort={ativa ? (crescente ? "ascending" : "descending") : "none"}
      title={dica}
    >
      <a
        className={ativa ? "sb-an-ordem sb-an-ordem-ativa" : "sb-an-ordem"}
        href={buildHref(filters, { order: nextOrder(filters.order, coluna) })}
      >
        {rotulo}
        <span className="sb-an-ordem-seta" aria-hidden="true">
          {ativa ? (crescente ? "↑" : "↓") : "↕"}
        </span>
      </a>
    </th>
  );
}

export default async function AnunciosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();

  // As contas e os filtros salvos não dependem da organização (a RLS já os
  // restringe): saem juntos com o membership desde D-195. As duas RPCs abaixo
  // continuam depois, porque elas SIM precisam da conta escolhida.
  const [membership, accountsResult, savedFiltersResult] = await Promise.all([
    currentMembership(),
    supabase.from("ml_accounts").select("id, slug, label").order("label"),
    supabase.from("saved_filters").select("id, name, params").eq("screen", "/anuncios").order("name"),
  ]);

  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle eyebrow="COMERCIAL / CATÁLOGO" title="Dashboard de anúncios" />
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const accounts = accountsResult.data ?? [];
  const savedFilters: SavedFilter[] = (savedFiltersResult.data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    params: row.params as Record<string, string>,
  }));

  const requestedAccount = typeof query.conta === "string" ? query.conta : null;
  const selectedAccount = accounts.find((a) => a.slug === requestedAccount) ?? null;

  const filters: Filters = {
    // Slug desconhecido cai em "todas as contas" em silêncio — mesmo
    // tratamento de `/vendas`, não é erro de rede nem de dado.
    account: selectedAccount?.slug ?? null,
    status: resolveStatusFilter(query.estado),
    link: resolveLinkStateFilter(query.vinculo),
    stock: resolveStockFilter(query.estoque),
    full: resolveFullFilter(query.full),
    sold: resolveSoldFilter(query.venda),
    days: resolvePeriodDays(query.dias),
    search: typeof query.busca === "string" && query.busca.trim() !== "" ? query.busca.trim() : null,
    order: resolveOrder(query.ordem),
    pageSize: resolvePageSize(query.tamanho, PAGE_SIZE),
    page: resolvePage(query.pagina),
  };

  // A janela sai do filtro (D-308). `days - 1` porque o intervalo da RPC é
  // fechado nas duas pontas: "últimos 7 dias" é hoje mais seis.
  const now = new Date();
  const { from: dateFrom, to: dateTo } = lastBusinessDays(filters.days, now);

  const listaSemOrdem = {
    p_organization_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_ml_account_id: selectedAccount?.id ?? null,
    p_search: filters.search,
    p_status: filters.status,
    p_link_state: filters.link,
    p_stock: filters.stock,
    p_full: filters.full,
    p_sold: filters.sold,
    p_limit: filters.pageSize,
    p_offset: (filters.page - 1) * filters.pageSize,
  };

  /*
    Duas leituras em paralelo: a página e a faixa. O ESCOPO da faixa é conta +
    busca, sem os filtros de estado — cada célula É um filtro de estado, e
    contá-la já filtrada por outro daria sempre zero ou o próprio número.
  */
  const [paginaNova, faixaNova] = await Promise.all([
    supabase.rpc("get_listings_dashboard", { ...listaSemOrdem, p_order: orderKey(filters.order) }),
    supabase.rpc("get_listings_dashboard_counts", {
      p_organization_id: organizationId,
      p_ml_account_id: selectedAccount?.id ?? null,
      p_search: filters.search,
    }),
  ]);

  /*
    BANCO AINDA SEM 20260918150000 (PGRST202). A web e a migration chegam a
    produção por caminhos diferentes — a web pela promoção na Vercel, a
    migration pelo `migrations-producao.yml` com duas aprovações (D-334) — e em
    18/09 uma tela publicada antes da migration dela virou 404 (`/notas-fiscais`).
    Aqui a tela cai na assinatura antiga: lista por faturamento, sem foto, e a
    faixa pelas seis chamadas de antes. Mesmo desenho de `/compras` e `/full`.
  */
  const bancoAntigo = paginaNova.error?.code === "PGRST202" || faixaNova.error?.code === "PGRST202";

  let pagina = paginaNova;
  // Contagem em erro é `undefined` e a célula diz "—", nunca zero: D-067 vale
  // para a faixa igual vale para a tabela. Uma leitura que falhou e vira "0 sem
  // estoque" afirma que está tudo bem — a mentira mais cara desta tela.
  let contagens: Partial<Record<"total" | "active" | "paused" | "out_of_stock" | "in_full" | "unlinked", number | undefined>> =
    faixaNova.error === null ? (faixaNova.data[0] ?? {}) : {};

  if (bancoAntigo) {
    const contar = (extra: { p_status?: string; p_stock?: string; p_full?: string; p_link_state?: string }) =>
      supabase.rpc("get_listings_dashboard", {
        p_organization_id: organizationId,
        p_date_from: dateFrom,
        p_date_to: dateTo,
        p_ml_account_id: selectedAccount?.id ?? null,
        p_search: filters.search,
        p_limit: 1,
        ...extra,
      });

    const [antiga, total, ativos, pausados, semEstoque, noFull, semVinculo] = await Promise.all([
      supabase.rpc("get_listings_dashboard", listaSemOrdem),
      contar({}),
      contar({ p_status: "active" }),
      contar({ p_status: "paused" }),
      contar({ p_stock: "out" }),
      contar({ p_full: "with" }),
      contar({ p_link_state: "unlinked" }),
    ]);
    const ler = (r: { data: { total_count: number }[] | null; error: unknown }): number | undefined =>
      r.error === null ? (r.data?.[0]?.total_count ?? 0) : undefined;

    pagina = antiga;
    contagens = {
      total: ler(total),
      active: ler(ativos),
      paused: ler(pausados),
      out_of_stock: ler(semEstoque),
      in_full: ler(noFull),
      unlinked: ler(semVinculo),
    };
  }

  const { data, error } = pagina;

  const rows = (data ?? []) as DashboardRow[];
  // `total_count` vem repetido em toda linha (window function). Zero linhas
  // significa zero no conjunto filtrado — a resposta certa.
  const totalCount = rows[0]?.total_count ?? 0;
  const window = summarizeWindow(filters.page, totalCount, rows.length, filters.pageSize);

  const numero = (valor: number | undefined): string => (valor === undefined ? "—" : formatCount(valor));

  const celulas: KpiCellData[] = [
    {
      // O total é LIDO, não somado. Ativos + pausados + fechados nem sempre
      // fecha (existe `under_review`).
      label: "Anúncios monitorados",
      formula: "Total no escopo atual (conta e busca), sem filtro de estado.",
      value: numero(contagens.total),
      previous: null,
      href: buildHref(filters, NEUTRO),
      tom: "info",
    },
    {
      label: "Ativos",
      formula: "listings.status = 'active' no escopo atual.",
      value: numero(contagens.active),
      previous: null,
      href: buildHref(filters, { ...NEUTRO, status: "active" }),
      tom: "ok",
    },
    {
      label: "Pausados",
      formula: "listings.status = 'paused' no escopo atual.",
      value: numero(contagens.paused),
      previous: null,
      href: buildHref(filters, { ...NEUTRO, status: "paused" }),
      tom: "neutro",
    },
    {
      label: "Sem estoque",
      formula: "listings.available_quantity = 0 — estoque DO ANÚNCIO, não o do ERP nem o do Full.",
      value: numero(contagens.out_of_stock),
      previous: null,
      href: buildHref(filters, { ...NEUTRO, stock: "out" }),
      tom: "perigo",
    },
    {
      label: "No Full",
      formula: "Full do anúncio > 0 — soma do último snapshot por inventory_id nos últimos 3 dias (definição canônica D-173/D-204).",
      value: numero(contagens.in_full),
      previous: null,
      href: buildHref(filters, { ...NEUTRO, full: "with" }),
      tom: "info",
    },
    {
      label: "Sem vínculo",
      formula: "Nem por anúncio nem por variação — a fila da Central de Vinculações (D-122).",
      value: numero(contagens.unlinked),
      previous: null,
      href: buildHref(filters, { ...NEUTRO, link: "unlinked" }),
      tom: "atencao",
    },
  ];

  const rotuloConta = selectedAccount?.label ?? "Todas as contas";
  const rotuloEstado = filters.status === null ? "Todos os estados" : listingStatusLabel(filters.status);
  const rotuloVinculo = LINK_STATE_FILTERS.find((f) => f.key === filters.link)?.label ?? "Com ou sem vínculo";
  const rotuloEstoque = STOCK_FILTERS.find((f) => f.key === filters.stock)?.label ?? "Qualquer estoque";
  const rotuloFull = FULL_FILTERS.find((f) => f.key === filters.full)?.label ?? "Full ou não";
  const rotuloVenda = SOLD_FILTERS.find((f) => f.key === filters.sold)?.label ?? "Com ou sem venda";
  const rotuloPeriodo = `Últimos ${String(filters.days)} dias`;

  /*
    Os filtros ATIVOS, como chips que se desfazem com um clique. Era uma frase
    ("Filtros ativos: …") que dizia o estado mas não deixava mudá-lo — tirar
    um recorte pedia achar o menu certo e a opção neutra. O período e a conta
    não entram: não têm posição "sem filtro" (a janela sempre existe) ou já se
    leem no botão do cabeçalho.
  */
  const chips: { rotulo: string; href: string }[] = [
    ...(filters.status === null ? [] : [{ rotulo: rotuloEstado, href: buildHref(filters, { status: null }) }]),
    ...(filters.link === "all" ? [] : [{ rotulo: rotuloVinculo, href: buildHref(filters, { link: "all" }) }]),
    ...(filters.stock === "all" ? [] : [{ rotulo: rotuloEstoque, href: buildHref(filters, { stock: "all" }) }]),
    ...(filters.full === "all" ? [] : [{ rotulo: rotuloFull, href: buildHref(filters, { full: "all" }) }]),
    ...(filters.sold === "all" ? [] : [{ rotulo: rotuloVenda, href: buildHref(filters, { sold: "all" }) }]),
    ...(filters.search === null ? [] : [{ rotulo: `Busca “${filters.search}”`, href: buildHref(filters, { search: null }) }]),
  ];
  const limpar = buildHref(filters, NEUTRO);

  const hidden = (nome: string, valor: string | null): ReactNode =>
    valor === null ? null : <input type="hidden" name={nome} value={valor} />;

  return (
    <Shell>
      <PageTitle
        eyebrow="COMERCIAL / CATÁLOGO"
        title="Dashboard de anúncios"
        subtitle={
          <>
            Catálogo do Mercado Livre sincronizado a cada 6h — estado, estoque, Full, venda, visitas e conversão dos
            últimos {filters.days} dias. A fila dos sem vínculo está na{" "}
            <Link href="/vinculacoes">Central de Vinculações</Link>.
          </>
        }
        aside={
          <>
            {/*
              Como no frame: o cabeçalho recorta O QUE SE OLHA (conta, período,
              vínculo, busca); os filtros de ESTADO da tabela moram na barra do
              painel. Todo o recorte vive na URL, nunca em estado React: é o
              que mantém o link compartilhável, o voltar do navegador e os
              Filtros Salvos.
            */}
            <SavedFilters screen="/anuncios" organizationId={organizationId} filters={savedFilters} />

            <FilterMenu
              rotulo={rotuloConta}
              opcoes={[
                { href: buildHref(filters, { account: null }), ativo: filters.account === null, label: "Todas as contas" },
                ...accounts.map((account) => ({
                  href: buildHref(filters, { account: account.slug }),
                  ativo: filters.account === account.slug,
                  label: account.label,
                })),
              ]}
            />

            {/* O período muda o significado das colunas de venda, visitas e
                conversão da tela inteira — por isso mora no cabeçalho. */}
            <FilterMenu
              rotulo={rotuloPeriodo}
              opcoes={PERIOD_PRESETS.map((dias) => ({
                href: buildHref(filters, { days: dias }),
                ativo: filters.days === dias,
                label: `Últimos ${String(dias)} dias`,
              }))}
            />

            <FilterMenu
              rotulo={rotuloVinculo}
              opcoes={LINK_STATE_FILTERS.map((option) => ({
                href: buildHref(filters, { link: option.key }),
                ativo: filters.link === option.key,
                label: option.label,
              }))}
            />

            <form method="get" action="/anuncios" className="sb-an-busca" role="search">
              {/*
                Hidden para cada dimensão ativa: um GET nativo envia SÓ os campos
                do formulário, então sem isto buscar descartaria o resto do
                recorte. Mesmo cuidado de `/vendas` (D-136).
              */}
              {hidden("conta", filters.account)}
              {hidden("estado", filters.status)}
              {hidden("vinculo", filters.link === "all" ? null : filters.link)}
              {hidden("estoque", filters.stock === "all" ? null : filters.stock)}
              {hidden("full", filters.full === "all" ? null : filters.full)}
              {hidden("venda", filters.sold === "all" ? null : filters.sold)}
              {hidden("dias", filters.days === DEFAULT_PERIOD_DAYS ? null : String(filters.days))}
              {hidden("ordem", orderParam(filters.order))}
              {hidden("tamanho", filters.pageSize === PAGE_SIZE ? null : String(filters.pageSize))}
              <span className="sb-an-busca-icone" aria-hidden="true">
                <Icone nome="lupa" tamanho={14} />
              </span>
              <input
                type="search"
                name="busca"
                className="sb-input"
                defaultValue={filters.search ?? ""}
                placeholder="SKU, MLB ou título"
                aria-label="Buscar por SKU, MLB ou título"
              />
              <button type="submit" className="sb-button">
                Buscar
              </button>
            </form>
          </>
        }
      />

      <KpiStrip ancora cells={celulas} />

      <div className="sb-an-lista">
        <Panel
          title="Anúncios monitorados"
          subtitle={error === null ? window.label : undefined}
          aside={
            <>
              <FilterMenu
                rotulo={rotuloEstado}
                opcoes={[
                  { href: buildHref(filters, { status: null }), ativo: filters.status === null, label: "Todos os estados" },
                  ...["active", "paused", "closed"].map((status) => ({
                    href: buildHref(filters, { status }),
                    ativo: filters.status === status,
                    label: listingStatusLabel(status),
                  })),
                ]}
              />
              <FilterMenu
                rotulo={rotuloEstoque}
                opcoes={STOCK_FILTERS.map((option) => ({
                  href: buildHref(filters, { stock: option.key }),
                  ativo: filters.stock === option.key,
                  label: option.label,
                }))}
              />
              <FilterMenu
                rotulo={rotuloFull}
                opcoes={FULL_FILTERS.map((option) => ({
                  href: buildHref(filters, { full: option.key }),
                  ativo: filters.full === option.key,
                  label: option.label,
                }))}
              />
              <FilterMenu
                rotulo={rotuloVenda}
                opcoes={SOLD_FILTERS.map((option) => ({
                  href: buildHref(filters, { sold: option.key }),
                  ativo: filters.sold === option.key,
                  label: option.label,
                }))}
              />
            </>
          }
        >
          {chips.length > 0 && (
            <div className="sb-an-chips" aria-label="Filtros ativos">
              <span className="sb-an-chips-rotulo">Filtros ativos:</span>
              {chips.map((chip) => (
                <a key={chip.rotulo} className="sb-an-chip" href={chip.href} aria-label={`Tirar o filtro ${chip.rotulo}`}>
                  {chip.rotulo}
                  <span aria-hidden="true">×</span>
                </a>
              ))}
              <a className="sb-text-button sb-an-limpar" href={limpar}>
                Limpar filtros
              </a>
            </div>
          )}

          {bancoAntigo && (
            <p role="note" className="sb-an-nota">
              Ordenação por coluna e foto dos anúncios chegam com a próxima atualização do banco; até lá a lista segue
              por faturamento.
            </p>
          )}

          {filters.sold === "without" && (
            // A ressalva só aparece quando é ela que está em jogo. "Sem venda"
            // é ausência de MÉTRICA no período, e o recálculo só materializa
            // dias tocados pela reconciliação — dizer isso evita ler "não
            // vendeu" onde pode ser "não foi calculado".
            <p className="sb-an-nota">
              sem venda = nenhuma métrica de venda no período, e o recálculo só materializa dias tocados pela
              reconciliação
            </p>
          )}

          {error !== null && (
            <div role="alert" className="sb-an-estado sb-an-estado-erro">
              <b>Não foi possível carregar os anúncios.</b>
              <span>{error.message}</span>
              <a className="sb-button" href={buildHref(filters, { page: filters.page })}>
                Tentar de novo
              </a>
            </div>
          )}

          {error === null && rows.length === 0 && (
            <div className="sb-an-estado">
              <b>Nenhum anúncio corresponde a estes filtros.</b>
              {chips.length > 0 ? (
                <a className="sb-button" href={limpar}>
                  Limpar filtros
                </a>
              ) : (
                <span>O catálogo desta conta ainda não foi sincronizado.</span>
              )}
            </div>
          )}

          {error === null && rows.length > 0 && (
            <div className="sb-an-rolagem">
              <table className="sb-table sb-an-tabela">
                <thead>
                  <tr>
                    <Cabecalho coluna="title" rotulo="Anúncio" filters={filters} ordena={!bancoAntigo} />
                    <th>Status</th>
                    <Cabecalho coluna="price" rotulo="Preço" filters={filters} ordena={!bancoAntigo} numerico />
                    <Cabecalho
                      coluna="stock"
                      rotulo="Estoque"
                      filters={filters} ordena={!bancoAntigo}
                      numerico
                      dica="Estoque DO ANÚNCIO no Mercado Livre — não o do ERP nem o do Full"
                    />
                    <Cabecalho
                      coluna="full"
                      rotulo="Full"
                      filters={filters} ordena={!bancoAntigo}
                      numerico
                      dica="Soma do último snapshot por bucket (inventory_id), últimos 3 dias"
                    />
                    <Cabecalho coluna="units" rotulo="Unidades" filters={filters} ordena={!bancoAntigo} numerico />
                    <Cabecalho coluna="revenue" rotulo="Faturamento" filters={filters} ordena={!bancoAntigo} numerico />
                    <Cabecalho coluna="visits" rotulo="Visitas" filters={filters} ordena={!bancoAntigo} numerico />
                    <th className="sb-num" title="Dias com visitas observadas na janela — a base do denominador da conversão">
                      Obs.
                    </th>
                    <Cabecalho
                      coluna="conversion"
                      rotulo="Conversão"
                      filters={filters} ordena={!bancoAntigo}
                      numerico
                      dica="Pedidos dos dias com visita observada ÷ visitas — indefinida sem visita, nunca 0%"
                    />
                    <th>
                      <span className="sb-sr-only">Ações</span>
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((row) => {
                    const badge = linkStateBadge(row.link_state);
                    const zerado = row.available_quantity === 0;

                    return (
                      <tr key={row.listing_id} className={zerado ? "sb-an-linha-zerada" : undefined}>
                        <td className="sb-an-produto">
                          {/* `.product-cell` do frame: foto (ou monograma) + nome, e
                              a identidade do anúncio — MLB, SKU, conta — embaixo,
                              no lugar de três colunas que só repetiam códigos. */}
                          <span className="sb-an-produto-linha">
                            {(row.thumbnail_url ?? null) === null ? (
                              <span className="sb-product-thumb sb-an-foto" aria-hidden="true">
                                {monogramaDeProduto(row.title)}
                              </span>
                            ) : (
                              <img
                                className="sb-an-foto"
                                src={row.thumbnail_url ?? undefined}
                                alt=""
                                width={40}
                                height={40}
                                loading="lazy"
                                decoding="async"
                                referrerPolicy="no-referrer"
                              />
                            )}
                            <span className="sb-an-produto-texto">
                              <Link
                                className="sb-entity sb-an-titulo"
                                href={`/anuncios/${row.item_id}`}
                                title={`${row.title} — sincronizado em ${formatDateTime(row.synced_at)}`}
                              >
                                {row.title}
                              </Link>
                              <span className="sb-an-meta">
                                {/* Dashboard 360º do anúncio (D-168) — o destino individual. */}
                                <Link className="sb-mono" href={`/anuncios/${row.item_id}`}>
                                  {row.item_id}
                                </Link>
                                <span aria-hidden="true">·</span>
                                {row.sku_id !== null && row.sku !== null ? (
                                  <Link className="sb-mono" href={`/skus/${row.sku_id}`}>
                                    {row.sku}
                                  </Link>
                                ) : (
                                  <span className="sb-mono" style={{ color: badge.tone }} title={badge.hint}>
                                    {badge.label}
                                  </span>
                                )}
                                <span aria-hidden="true">·</span>
                                <span>{row.account_label}</span>
                              </span>
                            </span>
                          </span>
                        </td>
                        <td>
                          <StatusPill code={row.status} label={listingStatusLabel(row.status)} />
                        </td>
                        <td className="sb-num">{formatCurrency(row.price)}</td>
                        <td className="sb-num">
                          {zerado ? <span className="sb-an-zerado">0</span> : formatCount(row.available_quantity)}
                        </td>
                        {/* NULA sem snapshot: "—", nunca "0" (D-067). */}
                        <td className="sb-num">{row.full_quantity === null ? "—" : formatCount(row.full_quantity)}</td>
                        <td className="sb-num">{formatCount(row.units_sold)}</td>
                        <td className="sb-num sb-an-faturamento">{formatCurrency(row.gross_revenue)}</td>
                        <td className="sb-num">{row.visits === null ? "—" : formatCount(row.visits)}</td>
                        {/* Dias com coleta de visitas dentro da janela: sem ela, a
                            taxa ao lado seria lida como se cobrisse o período todo. */}
                        <td className="sb-num sb-an-suave" title="Dias com visitas observadas na janela">
                          {row.days_observed === 0 ? "—" : `${String(row.days_observed)}/${String(filters.days)}`}
                        </td>
                        <td className="sb-num">{formatPercent(row.conversion_rate)}</td>
                        <td className="sb-an-acoes">
                          {/* A gaveta: frescor, republicação e o que aconteceu —
                              o que a linha não carrega. */}
                          <InspecaoAnuncio
                            mlAccountId={row.ml_account_id}
                            itemId={row.item_id}
                            title={row.title}
                            status={row.status}
                            price={row.price}
                            availableQuantity={row.available_quantity}
                            fullQuantity={row.full_quantity}
                            accountLabel={row.account_label}
                            sku={row.sku}
                            skuId={row.sku_id}
                            compacto
                          />
                          {(row.permalink ?? null) !== null && (
                            <a
                              className="sb-icon-button sb-an-externo"
                              href={row.permalink ?? undefined}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`Abrir ${row.item_id} no Mercado Livre`}
                              title="Abrir no Mercado Livre"
                            >
                              <Icone nome="externo" tamanho={14} />
                            </a>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {error === null && totalCount > 0 && (
            <nav className="sb-an-paginacao" aria-label="Paginação dos anúncios">
              <FilterMenu
                rotulo={`${String(filters.pageSize)} por página`}
                opcoes={PAGE_SIZES.map((tamanho) => ({
                  href: buildHref(filters, { pageSize: tamanho }),
                  ativo: filters.pageSize === tamanho,
                  label: `${String(tamanho)} por página`,
                }))}
              />

              {window.totalPages > 1 && (
                <div className="sb-an-paginas">
                  {filters.page > 1 ? (
                    <a className="sb-button" href={buildHref(filters, { page: filters.page - 1 })}>
                      ‹ Anterior
                    </a>
                  ) : (
                    <span className="sb-button" aria-disabled="true">
                      ‹ Anterior
                    </span>
                  )}
                  {pageNumbers(filters.page, window.totalPages).map((numeroDaPagina, indice) =>
                    numeroDaPagina === "…" ? (
                      <span key={`salto-${String(indice)}`} className="sb-an-salto" aria-hidden="true">
                        …
                      </span>
                    ) : (
                      <a
                        key={numeroDaPagina}
                        className={numeroDaPagina === filters.page ? "sb-an-pagina sb-an-pagina-atual" : "sb-an-pagina"}
                        href={buildHref(filters, { page: numeroDaPagina })}
                        aria-current={numeroDaPagina === filters.page ? "page" : undefined}
                        aria-label={`Página ${String(numeroDaPagina)}`}
                      >
                        {formatCount(numeroDaPagina)}
                      </a>
                    ),
                  )}
                  {filters.page < window.totalPages ? (
                    <a className="sb-button" href={buildHref(filters, { page: filters.page + 1 })}>
                      Próxima ›
                    </a>
                  ) : (
                    <span className="sb-button" aria-disabled="true">
                      Próxima ›
                    </span>
                  )}
                </div>
              )}
            </nav>
          )}
        </Panel>

        {/*
          A metodologia da conversão (numerador só dos dias com visita
          observada; sem visita a taxa é indefinida, não 0%) mora no `title`
          dos cabeçalhos "Obs." e "Conversão". Os ids canônicos (`visitas`,
          `taxa_conversao`) continuam em docs/METRICS.md.
        */}
      </div>
    </Shell>
  );
}
