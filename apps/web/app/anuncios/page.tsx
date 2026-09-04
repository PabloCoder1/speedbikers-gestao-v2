import Link from "next/link";
import type { ReactNode } from "react";

import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { StatusPill } from "../../components/status-pill";
import { formatCount, formatCurrency, formatDateTime, formatPercent } from "../../lib/format";
import { listingStatusLabel } from "../../lib/labels";
import {
  LINK_STATE_FILTERS,
  PAGE_SIZE,
  STOCK_FILTERS,
  linkStateBadge,
  resolveLinkStateFilter,
  resolvePage,
  resolveStatusFilter,
  resolveStockFilter,
  summarizeWindow,
} from "../../lib/listings-dashboard";
import { buildFilterHref } from "../../lib/filters";
import { createClient } from "../../lib/supabase/server";
import { currentMembership } from "../../lib/membership";

export const metadata = { title: "Anúncios — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de apps/web/app/estoque/page.tsx.
export const dynamic = "force-dynamic";

/**
 * Dashboard de Anúncios (Fase 5C, D-138; composição do Figma em D-242).
 *
 * **Deixou de ser lista e passou a responder perguntas**, que é o que
 * `docs/PRODUCT_REQUIREMENTS.md` pede: quais anúncios existem, em qual conta,
 * com qual SKU, quais venderam, quais não têm vínculo.
 *
 * 🔴 **A versão anterior mostrava 1.000 de 5.085 anúncios, em silêncio.** Lia
 * `from("listings").select(...).order("title")` sem `.range()`, e o PostgREST
 * corta em `max_rows = 1000` devolvendo `error` NULO — sexta ocorrência da
 * classe de D-131. Como ordenava por título, o que sobrevivia eram "os 1.000
 * primeiros no alfabeto".
 *
 * Agora o pivô, os filtros, a ordenação e a CONTAGEM vivem no Postgres
 * (`get_listings_dashboard`) e a tela lê uma janela declarada, exibindo
 * sempre "N de M" — mesmo precedente que D-131 usou em `/estoque`.
 *
 * ## A faixa de estados, e o que ela NÃO diz (D-242)
 *
 * O frame `Listings` abre com seis células de resumo. Quatro o sistema mede:
 * ativos, pausados, sem estoque e sem vínculo. **Duas ele não mede**, e ficaram
 * de fora em vez de virarem número inventado:
 *
 *   - **"No Full"** é fato de SKU, não de anúncio. `listings` não tem coluna de
 *     logística; o Full vive em `fulfillment_stock_snapshots`, com grão de SKU.
 *     Contar anúncios "no Full" seria trocar o grão no meio da faixa.
 *   - **"Com queda"** não existe: não há detecção de anomalia por anúncio, e
 *     "queda" não tem entrada em `metric_definitions`. D-023 proíbe estampar
 *     número sintetizado sem definição canônica por trás.
 *
 * A célula âncora ficou com o TOTAL, que é medido e é o denominador de todas as
 * outras — as duas ausências estão registradas em
 * `docs/DESIGN_IMPLEMENTATION.md` com o motivo.
 */

const LOOKBACK_DAYS = 30;

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
  total_count: number;
}

interface Filters {
  account: string | null;
  status: string | null;
  link: string;
  stock: string;
  search: string | null;
  page: number;
}

/**
 * Preserva as outras dimensões ao trocar uma — mesmo `buildHref` de
 * `/vendas`. Trocar de conta NÃO pode resetar o filtro de vínculo.
 *
 * Qualquer mudança de filtro volta para a página 1: manter o offset seria
 * mostrar "página 7 de 2", ou pior, uma página vazia que parece "nenhum
 * resultado".
 */
function buildHref(current: Filters, override: Partial<Filters>): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/anuncios",
    {
      conta: next.account,
      estado: next.status,
      // "all" e o default do vinculo: fica fora da URL, como os demais.
      vinculo: next.link === "all" ? null : next.link,
      estoque: next.stock === "all" ? null : next.stock,
      busca: next.search,
    },
    override.page === undefined ? 1 : next.page,
  );
}

/**
 * As duas letras do `.product-thumb` do frame.
 *
 * O Figma mostra "XR", "PF", "CB" — iniciais, não foto. Sai do próprio título,
 * então é sempre verdade sobre o anúncio que está na linha. Título de uma
 * palavra devolve as duas primeiras letras dela; título vazio não existe
 * (`listings.title` é NOT NULL), mas se existisse cairia em "—".
 */
function monograma(titulo: string): string {
  const palavras = titulo.trim().split(/\s+/).filter((p) => /\p{L}/u.test(p));

  if (palavras.length === 0) {
    return "—";
  }

  if (palavras.length === 1) {
    return (palavras[0] ?? "").slice(0, 2);
  }

  return `${(palavras[0] ?? "").slice(0, 1)}${(palavras[1] ?? "").slice(0, 1)}`;
}

/**
 * Contagem de uma célula da faixa.
 *
 * Devolve **`null` em erro**, nunca zero: D-067 vale para a faixa igual vale
 * para a tabela. Uma leitura que falhou e vira "0 sem estoque" afirma que está
 * tudo bem — a mentira mais cara desta tela.
 */
function contagem(resultado: { data: unknown; error: unknown }): number | null {
  if (resultado.error !== null) {
    return null;
  }

  const linhas = (resultado.data ?? []) as { total_count: number }[];

  return linhas[0]?.total_count ?? 0;
}

export default async function AnunciosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();

  // As contas não dependem da organização: a RLS já as restringe, e o `select`
  // de `organization_members` existe para o guarda de "sem organização", não
  // para filtrar. As duas leituras saem juntas desde D-195; as RPCs abaixo
  // continuam depois, porque elas SIM precisam da conta escolhida.
  const [membership, accountsResult] = await Promise.all([
    currentMembership(supabase),
    supabase.from("ml_accounts").select("id, slug, label").order("label"),
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

  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - (LOOKBACK_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const accounts = accountsResult.data ?? [];

  const requestedAccount = typeof query.conta === "string" ? query.conta : null;
  const selectedAccount = accounts.find((a) => a.slug === requestedAccount) ?? null;

  const filters: Filters = {
    // Slug desconhecido cai em "todas as contas" em silêncio — mesmo
    // tratamento de `/vendas`, não é erro de rede nem de dado.
    account: selectedAccount?.slug ?? null,
    status: resolveStatusFilter(query.estado),
    link: resolveLinkStateFilter(query.vinculo),
    stock: resolveStockFilter(query.estoque),
    search: typeof query.busca === "string" && query.busca.trim() !== "" ? query.busca.trim() : null,
    page: resolvePage(query.pagina),
  };

  const escopo = {
    p_organization_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_ml_account_id: selectedAccount?.id ?? null,
    p_search: filters.search,
  };

  /*
    Seis leituras num `Promise.all` só: a página mais as cinco contagens da
    faixa. **O custo de uma chamada ao banco é a ida e volta, não o SQL**
    (D-185) — em paralelo elas custam uma ida, e a faixa sai de graça no relógio.

    As contagens usam a MESMA função da lista, com `p_limit: 1` para ler só o
    `total_count`. É a decisão central desta faixa: se a célula diz "1 sem
    estoque", clicar nela mostra exatamente aquele 1, porque contagem e lista
    são a mesma consulta com o mesmo predicado. Uma segunda definição — um
    `count` próprio na tela, ou uma RPC de resumo à parte — seria um segundo
    dono do mesmo dado, e é assim que os dois números começam a divergir
    (D-224).

    O ESCOPO das contagens é conta + busca, sem os filtros de estado: cada
    célula É um filtro de estado, e contá-la já filtrada por outro estado daria
    sempre zero ou o próprio número da tela.
  */
  const [pagina, total, ativos, pausados, semEstoque, semVinculo] = await Promise.all([
    supabase.rpc("get_listings_dashboard", {
      ...escopo,
      p_status: filters.status,
      p_link_state: filters.link,
      p_stock: filters.stock,
      p_limit: PAGE_SIZE,
      p_offset: (filters.page - 1) * PAGE_SIZE,
    }),
    supabase.rpc("get_listings_dashboard", { ...escopo, p_limit: 1 }),
    supabase.rpc("get_listings_dashboard", { ...escopo, p_status: "active", p_limit: 1 }),
    supabase.rpc("get_listings_dashboard", { ...escopo, p_status: "paused", p_limit: 1 }),
    supabase.rpc("get_listings_dashboard", { ...escopo, p_stock: "out", p_limit: 1 }),
    supabase.rpc("get_listings_dashboard", { ...escopo, p_link_state: "unlinked", p_limit: 1 }),
  ]);

  const { data, error } = pagina;

  const rows = (data ?? []) as DashboardRow[];
  // `total_count` vem repetido em toda linha (window function). Zero linhas
  // significa zero no conjunto filtrado — não há de onde ler o total, e é a
  // resposta certa.
  const totalCount = rows[0]?.total_count ?? 0;
  const window = summarizeWindow(filters.page, totalCount, rows.length);

  const numero = (valor: number | null): string => (valor === null ? "—" : formatCount(valor));

  const celulas: KpiCellData[] = [
    {
      // O total é LIDO, não somado. Ativos + pausados + fechados nem sempre
      // fecha (existe `under_review`), e somar células seria inventar a
      // aritmética de um conjunto que a tela não enumera.
      label: "Anúncios monitorados",
      formula: "Total no escopo atual (conta e busca), sem filtro de estado.",
      value: numero(contagem(total)),
      previous: null,
      href: buildHref(filters, { status: null, link: "all", stock: "all" }),
      tom: "info",
    },
    {
      label: "Ativos",
      formula: "listings.status = 'active' no escopo atual.",
      value: numero(contagem(ativos)),
      previous: null,
      href: buildHref(filters, { status: "active", link: "all", stock: "all" }),
      tom: "ok",
    },
    {
      label: "Pausados",
      formula: "listings.status = 'paused' no escopo atual.",
      value: numero(contagem(pausados)),
      previous: null,
      href: buildHref(filters, { status: "paused", link: "all", stock: "all" }),
      tom: "neutro",
    },
    {
      label: "Sem estoque",
      formula: "listings.available_quantity = 0 — estoque DO ANÚNCIO, não o do ERP nem o do Full.",
      value: numero(contagem(semEstoque)),
      previous: null,
      href: buildHref(filters, { stock: "out", status: null, link: "all" }),
      tom: "perigo",
    },
    {
      label: "Sem vínculo",
      formula: "Nem por anúncio nem por variação — a fila da Central de Vinculações (D-122).",
      value: numero(contagem(semVinculo)),
      previous: null,
      href: buildHref(filters, { link: "unlinked", status: null, stock: "all" }),
      tom: "atencao",
    },
  ];

  const rotuloConta = selectedAccount?.label ?? "Todas as contas";
  const rotuloEstado = filters.status === null ? "Todos os estados" : listingStatusLabel(filters.status);
  const rotuloVinculo = LINK_STATE_FILTERS.find((f) => f.key === filters.link)?.label ?? "Todos";
  const rotuloEstoque = STOCK_FILTERS.find((f) => f.key === filters.stock)?.label ?? "Qualquer estoque";

  // A linha "Filtros ativos: …" do frame, com os filtros que estão de fato
  // ativos — não um texto fixo.
  const filtrosAtivos = [
    rotuloConta,
    `últimos ${String(LOOKBACK_DAYS)} dias`,
    ...(filters.status === null ? [] : [rotuloEstado]),
    ...(filters.link === "all" ? [] : [rotuloVinculo.toLowerCase()]),
    ...(filters.stock === "all" ? [] : [rotuloEstoque.toLowerCase()]),
    ...(filters.search === null ? [] : [`busca “${filters.search}”`]),
  ].join(" · ");

  return (
    <Shell>
      <PageTitle
        eyebrow="COMERCIAL / CATÁLOGO"
        title="Dashboard de anúncios"
        subtitle={
          <>
            Catálogo real do Mercado Livre (D-121), sincronizado a cada 6h, com venda, visitas e conversão dos
            últimos {LOOKBACK_DAYS} dias. Anúncio sem vínculo aparece aqui — a fila de trabalho para vinculá-los
            está na <Link href="/vinculacoes">Central de Vinculações</Link>.
          </>
        }
        aside={
          <>
            {/*
              Os filtros viraram a barra de menus do Figma, como em `/vendas` e
              `/produtos`. Todo o recorte continua na URL, nunca em estado
              React: é o que mantém o link compartilhável, o voltar do navegador
              funcionando e os Filtros Salvos possíveis.
            */}
            <details className="sb-menu">
              <summary className="sb-button">{rotuloConta} ▾</summary>
              <div className="sb-menu-panel">
                <a
                  className="sb-menu-item"
                  aria-current={filters.account === null ? "true" : undefined}
                  href={buildHref(filters, { account: null })}
                >
                  Todas as contas
                </a>
                {accounts.map((account) => (
                  <a
                    key={account.id}
                    className="sb-menu-item"
                    aria-current={filters.account === account.slug ? "true" : undefined}
                    href={buildHref(filters, { account: account.slug })}
                  >
                    {account.label}
                  </a>
                ))}
              </div>
            </details>

            <details className="sb-menu">
              <summary className="sb-button">{rotuloEstado} ▾</summary>
              <div className="sb-menu-panel">
                <a
                  className="sb-menu-item"
                  aria-current={filters.status === null ? "true" : undefined}
                  href={buildHref(filters, { status: null })}
                >
                  Todos os estados
                </a>
                {["active", "paused", "closed"].map((status) => (
                  <a
                    key={status}
                    className="sb-menu-item"
                    aria-current={filters.status === status ? "true" : undefined}
                    href={buildHref(filters, { status })}
                  >
                    {listingStatusLabel(status)}
                  </a>
                ))}
              </div>
            </details>

            <details className="sb-menu">
              <summary className="sb-button">{rotuloVinculo} ▾</summary>
              <div className="sb-menu-panel">
                {LINK_STATE_FILTERS.map((option) => (
                  <a
                    key={option.key}
                    className="sb-menu-item"
                    aria-current={filters.link === option.key ? "true" : undefined}
                    href={buildHref(filters, { link: option.key })}
                  >
                    {option.label}
                  </a>
                ))}
              </div>
            </details>

            <details className="sb-menu">
              <summary className="sb-button">{rotuloEstoque} ▾</summary>
              <div className="sb-menu-panel">
                {STOCK_FILTERS.map((option) => (
                  <a
                    key={option.key}
                    className="sb-menu-item"
                    aria-current={filters.stock === option.key ? "true" : undefined}
                    href={buildHref(filters, { stock: option.key })}
                  >
                    {option.label}
                  </a>
                ))}
              </div>
            </details>

            <form method="get" action="/anuncios" style={{ display: "flex", gap: "0.375rem" }}>
              {/*
                Hidden para cada dimensão ativa: um GET nativo envia SÓ os campos
                do formulário, então sem isto buscar descartaria conta, vínculo,
                estado e estoque. Mesmo cuidado de `/vendas` (D-136).
              */}
              {filters.account !== null && <input type="hidden" name="conta" value={filters.account} />}
              {filters.status !== null && <input type="hidden" name="estado" value={filters.status} />}
              {filters.link !== "all" && <input type="hidden" name="vinculo" value={filters.link} />}
              {filters.stock !== "all" && <input type="hidden" name="estoque" value={filters.stock} />}
              <input
                type="search"
                name="busca"
                defaultValue={filters.search ?? ""}
                placeholder="SKU, MLB ou título"
                aria-label="Buscar por SKU, MLB ou título"
                style={{
                  height: "2rem",
                  padding: "0 0.625rem",
                  borderRadius: "var(--sb-radius-md)",
                  border: "1px solid var(--sb-border)",
                  fontSize: "0.6875rem",
                  minWidth: "12rem",
                }}
              />
              <button type="submit" className="sb-button">
                Buscar
              </button>
            </form>
          </>
        }
      />

      <KpiStrip ancora cells={celulas} />

      <div style={{ marginTop: "var(--sb-space-3)" }}>
        <Panel
          title="Anúncios monitorados"
          subtitle={`Filtros ativos: ${filtrosAtivos}`}
          aside={
            error === null ? (
              <span style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>{window.label}</span>
            ) : undefined
          }
        >
          {error !== null && (
            <p role="alert" style={{ margin: 0, padding: "var(--sb-space-3)", color: "var(--sb-danger)" }}>
              Não foi possível carregar: {error.message}
            </p>
          )}

          {error === null && rows.length === 0 && (
            <p style={{ margin: 0, padding: "var(--sb-space-3)", color: "var(--sb-text-soft)", fontSize: "0.6875rem" }}>
              Nenhum anúncio corresponde a estes filtros.
            </p>
          )}

          {error === null && rows.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>Anúncio</th>
                    <th>MLB</th>
                    <th>SKU</th>
                    <th>Conta</th>
                    <th>Status</th>
                    <th className="sb-num">Preço</th>
                    <th className="sb-num">Estoque</th>
                    <th className="sb-num">Unidades</th>
                    <th className="sb-num">Faturamento</th>
                    <th className="sb-num">Visitas</th>
                    <th className="sb-num">Obs.</th>
                    <th className="sb-num">Conversão</th>
                    <th>Sincronizado em</th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((row) => {
                    const badge = linkStateBadge(row.link_state);

                    return (
                      <tr key={row.listing_id}>
                        <td>
                          {/* `.product-cell` do frame: monograma + nome. */}
                          <span className="sb-product-cell">
                            <span className="sb-product-thumb" aria-hidden="true">
                              {monograma(row.title)}
                            </span>
                            <Link className="sb-entity" href={`/anuncios/${row.item_id}`}>
                              {row.title}
                            </Link>
                          </span>
                        </td>
                        <td style={{ fontFamily: "var(--sb-mono)" }}>
                          {/* Dashboard 360º do anúncio (D-168) — o destino individual. */}
                          <Link href={`/anuncios/${row.item_id}`}>{row.item_id}</Link>
                        </td>
                        <td style={{ fontFamily: "var(--sb-mono)" }}>
                          {row.sku_id !== null && row.sku !== null ? (
                            <Link href={`/skus/${row.sku_id}`}>{row.sku}</Link>
                          ) : (
                            <span style={{ color: badge.tone }} title={badge.hint}>
                              {badge.label}
                            </span>
                          )}
                        </td>
                        <td>{row.account_label}</td>
                        <td>
                          <StatusPill code={row.status} label={listingStatusLabel(row.status)} />
                        </td>
                        <td className="sb-num">
                          {formatCurrency(row.price)}
                        </td>
                        <td className="sb-num">
                          {row.available_quantity}
                        </td>
                        <td className="sb-num">
                          {formatCount(row.units_sold)}
                        </td>
                        <td className="sb-num">
                          {formatCurrency(row.gross_revenue)}
                        </td>
                        <td className="sb-num">
                          {row.visits === null ? "—" : formatCount(row.visits)}
                        </td>
                        {/*
                          Dias com coleta de visitas dentro da janela: é a base do
                          denominador, e sem ela a taxa ao lado seria lida como se
                          cobrisse os 30 dias.
                        */}
                        <td className="sb-num" style={{ color: "var(--sb-text-soft)" }} title="Dias com visitas observadas na janela">
                          {row.days_observed === 0 ? "—" : `${String(row.days_observed)}/${String(LOOKBACK_DAYS)}`}
                        </td>
                        <td className="sb-num">
                          {formatPercent(row.conversion_rate)}
                        </td>
                        <td>{formatDateTime(row.synced_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <p style={{ margin: "var(--sb-space-2) 0 0", fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
          <span style={{ fontFamily: "var(--sb-mono)" }}>visitas</span> ·{" "}
          <span style={{ fontFamily: "var(--sb-mono)" }}>taxa_conversao</span> — a conversão usa como numerador os
          pedidos dos dias em que houve coleta de visitas (a coluna “obs.” mostra quantos foram), nunca a janela
          inteira sobre um denominador parcial. Sem visita observada a taxa fica “—”: indefinida, não 0%.
          {error === null && window.totalPages > 1 && (
            <>
              {" · "}
              {filters.page > 1 && <a href={buildHref(filters, { page: filters.page - 1 })}>Anterior</a>}
              {filters.page > 1 && filters.page < window.totalPages && " · "}
              {filters.page < window.totalPages && (
                <a href={buildHref(filters, { page: filters.page + 1 })}>Próxima</a>
              )}
            </>
          )}
        </p>
      </div>
    </Shell>
  );
}
