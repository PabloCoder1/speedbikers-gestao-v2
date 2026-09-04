import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { KpiStrip, type KpiCellData } from "../../../components/kpi-strip";
import { ObjectHeader, type ObjectBadge } from "../../../components/object-header";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { StatusPill } from "../../../components/status-pill";
import { TOM, tomDeStatus } from "../../../components/tone";
import { formatEventDiff } from "../../../lib/event-format";
import { formatBusinessDate, formatCount, formatCurrency, formatDateTime, formatPercent } from "../../../lib/format";
import { actionStatusLabel, eventTypeLabel, listingStatusLabel, statusTone } from "../../../lib/labels";
import { fullSituationCriterion, fullSituationLabel, fullSituationTom } from "../../../lib/full-filters";
import { formatDecisionSnapshot } from "../../../lib/decision-format";
import { createClient } from "../../../lib/supabase/server";

export const metadata = { title: "Dashboard do Anúncio — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Dashboard 360º do Anúncio (D-168, trilha 5E; composição do Figma em D13).
 *
 * Cada anúncio deixou de ser uma linha de lista e virou uma página com estado,
 * desempenho, Full e a própria história. **Agora em ABAS**, que era a evolução
 * registrada na primeira versão e que o dono nomeou por escrito: `Visão geral |
 * Vendas | Tráfego | Preço | Full | Histórico | Diagnóstico | Decisões`.
 *
 * ## O frame, e por que esta é uma PÁGINA e não um drawer
 *
 * O Figma desenha o anúncio como `MlbDetailDrawer` (600px, à direita) com
 * exatamente estas oito abas. A V3 tem uma ROTA — `/anuncios/[itemId]` —, que
 * `/anuncios` e o Dashboard de SKU já linkam e que uma notificação pode abrir.
 * Trocar a rota por um drawer removeria um destino que existe e é
 * compartilhável. O que se copia do frame é a COMPOSIÇÃO: cabeçalho de
 * entidade com identificador em mono, selos, ações à direita, e a fileira de
 * abas — o mesmo `ObjectHeader` que o SKU usa desde D8.
 *
 * O frame só desenha a aba "Visão geral"; as outras sete dizem "Aba em
 * construção". Vale então a mesma regra registrada para o SKU: aplicar o
 * design system, não inventar um frame.
 *
 * ## O que o frame mostra e a V3 não tem
 *
 * "Tipo" (Premium/Clássico) e "Catálogo" (Vencedor) não existem em `listings`.
 * O bloco "Exposição em Risco" com o botão "Repor Full" é veredito sintetizado
 * mais ação de escrita sem política logística — os dois já são desvios
 * registrados. E "Saúde do Anúncio" (competitividade de preço, qualidade das
 * fotos) não tem fonte: do painel sobra o que é medido, que é o Full.
 *
 * **Republicar não sai daqui.** O motor de relist existe (`listing_relists`,
 * nove estados, escrito pelo worker e pela API), mas a primeira republicação
 * real é ato humano deliberado, ainda pendente em `docs/HANDOFF.md`. A tela
 * LÊ o histórico de republicação na aba Histórico e não oferece disparo.
 *
 * ## Leitura
 *
 * Cada aba dispara só as consultas de que precisa (o resto vira
 * `Promise.resolve`) — o mesmo progressive disclosure real do SKU, e o que
 * mata o risco "N+1 por aba" de `docs/ARCHITECTURE.md` §21.
 */

const LOOKBACK_DAYS = 30;
const TIMELINE_LIMIT = 50;

const TAB_KEYS = [
  "visao-geral",
  "vendas",
  "trafego",
  "preco",
  "full",
  "historico",
  "diagnostico",
  "decisoes",
] as const;
type TabKey = (typeof TAB_KEYS)[number];

const TAB_LABELS: Record<TabKey, string> = {
  "visao-geral": "Visão geral",
  vendas: "Vendas",
  trafego: "Tráfego",
  preco: "Preço",
  full: "Full",
  historico: "Histórico",
  diagnostico: "Diagnóstico",
  decisoes: "Decisões",
};

/** Valor fora do conjunto fechado cai na Visão geral ANTES de tocar o banco. */
function parseTab(value: string | string[] | undefined): TabKey {
  return typeof value === "string" && (TAB_KEYS as readonly string[]).includes(value)
    ? (value as TabKey)
    : "visao-geral";
}

interface TimelineEventRow {
  id: string;
  event_type: string;
  severity: string;
  occurred_at: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  entity_type: string;
}

interface DiaMetricaRow {
  metric_date: string;
  units_sold: number;
  gross_revenue: number;
  orders_count: number;
  purchases_count: number;
}

interface DiaVisitaRow {
  metric_date: string;
  visits: number;
}

interface RelistRow {
  id: string;
  child_item_id: string | null;
  status: string;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface DecisionRow {
  id: string;
  decision: string;
  baseline_snapshot: unknown;
  created_at: string;
  actions: { kind: string; status: string; recommendation: string } | null;
}

/**
 * Tom do estado do relist. Nove estados, três desfechos: terminou bem, está a
 * caminho, ou falhou — e falha nunca fica neutra.
 */
function relistTom(status: string): "ok" | "atencao" | "perigo" | "neutro" {
  if (status === "REMAPPED" || status === "RELISTED") return "ok";
  if (status.endsWith("_FAILED")) return "perigo";
  if (status === "REQUESTED" || status === "CLOSING" || status === "RELISTING") return "atencao";

  return "neutro";
}

export default async function AnuncioPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { itemId } = await params;
  const query = await searchParams;
  const tab = parseTab(query.aba);
  const supabase = await createClient();

  // MLB ids são globais no Mercado Livre — um item pertence a UMA conta.
  // `null` pode ser "não existe" ou "a RLS escondeu": os dois viram 404,
  // mesmo raciocínio do Dashboard de SKU.
  const listing = await supabase
    .from("listings")
    .select(
      "id, organization_id, ml_account_id, item_id, sku_id, title, status, price, currency_id, available_quantity, synced_at, ml_accounts(label), skus(sku, title)",
    )
    .eq("item_id", itemId)
    .maybeSingle();

  if (listing.error !== null || listing.data === null) {
    notFound();
  }

  const row = listing.data;

  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - (LOOKBACK_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);

  const needsSummary = tab === "visao-geral" || tab === "vendas" || tab === "trafego";
  const needsFull = tab === "visao-geral" || tab === "full";
  const needsTimeline = tab === "historico";
  const needsActions = tab === "visao-geral";
  const needsDaily = tab === "vendas";
  const needsVisits = tab === "trafego";
  const needsPrices = tab === "preco";
  const needsRelists = tab === "historico";
  const needsDecisions = tab === "decisoes";

  const [
    summaryResult,
    fullDoAnuncioResult,
    fullResult,
    timelineResult,
    actionsResult,
    dailyResult,
    visitsResult,
    pricesResult,
    relistsResult,
    decisionsResult,
  ] = await Promise.all([
    needsSummary
      ? supabase
          .rpc("get_listing_dashboard_summary", {
            p_organization_id: row.organization_id,
            p_ml_account_id: row.ml_account_id,
            p_item_id: row.item_id,
            p_date_from: dateFrom,
            p_date_to: dateTo,
          })
          .single()
      : Promise.resolve({ data: null, error: null }),
    /*
      O Full DESTE ANÚNCIO, pela MESMA função que a lista `/anuncios` usa
      (D-243): soma do último snapshot por bucket dos últimos 3 dias, com o
      `item_id` do próprio anúncio. Sem isto a lista diria "Full 3" e o detalhe
      diria o total do SKU na conta — dois números sob o mesmo rótulo, que é
      exatamente como faixa e tabela começam a discordar (D-224). MLB é único,
      então a busca por `item_id` devolve este anúncio e mais nenhum.
    */
    needsFull
      ? supabase
          .rpc("get_listings_dashboard", {
            p_organization_id: row.organization_id,
            p_date_from: dateFrom,
            p_date_to: dateTo,
            p_ml_account_id: row.ml_account_id,
            p_search: row.item_id,
            p_limit: 1,
          })
      : Promise.resolve({ data: null, error: null }),
    // O contexto por SKU+CONTA: situação, saldo local e buckets. É espelho por
    // SKU, então sem vínculo não há como rastrear — e a tela DIZ isso em vez
    // de mostrar zero.
    //
    // Via RPC desde D-173, e não mais lendo uma linha da tabela: o saldo do
    // Full é por BUCKET (um por variação), e pegar a captura mais recente do
    // par SKU+conta mostrava UM bucket como se fosse o total. Medido: 246
    // pares têm mais de uma variação, e o erro escondia 15,6% das unidades.
    needsFull && row.sku_id !== null
      ? supabase
          .rpc("get_fulfillment_overview", {
            p_organization_id: row.organization_id,
            p_date_from: dateFrom,
            p_date_to: dateTo,
            p_ml_account_id: row.ml_account_id,
            p_situation: null,
            p_search: null,
            p_sku_id: row.sku_id,
            p_limit: 1,
            p_offset: 0,
          })
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    needsTimeline
      ? supabase
          .from("domain_events")
          .select("id, event_type, severity, occurred_at, before, after, entity_type")
          .eq("ml_account_id", row.ml_account_id)
          .eq("entity_type", "listing")
          .eq("entity_id", row.item_id)
          .order("occurred_at", { ascending: false })
          .limit(TIMELINE_LIMIT)
      : Promise.resolve({ data: null, error: null }),
    needsActions
      ? supabase
          .from("actions")
          .select("id, kind, status, recommendation, created_at")
          .eq("mlb_id", row.item_id)
          .order("created_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: null, error: null }),
    // Venda POR DIA deste anúncio. Leitura direta do recálculo diário sob RLS:
    // não é agregação (os totais vêm da RPC acima, somados no banco), é a
    // própria linha do grão — o mesmo que a aba Vendas do SKU faz.
    needsDaily
      ? supabase
          .from("daily_listing_metrics")
          .select("metric_date, units_sold, gross_revenue, orders_count, purchases_count")
          .eq("ml_account_id", row.ml_account_id)
          .eq("mlb_id", row.item_id)
          .gte("metric_date", dateFrom)
          .lte("metric_date", dateTo)
          .order("metric_date", { ascending: false })
      : Promise.resolve({ data: null, error: null }),
    needsVisits
      ? supabase
          .from("daily_listing_visits")
          .select("metric_date, visits")
          .eq("ml_account_id", row.ml_account_id)
          .eq("item_id", row.item_id)
          .gte("metric_date", dateFrom)
          .lte("metric_date", dateTo)
          .order("metric_date", { ascending: false })
      : Promise.resolve({ data: null, error: null }),
    // Preço observado: os eventos `listing.price.changed` DESTE anúncio. É um
    // recorte da mesma linha do tempo da aba Histórico — a fonte é uma só
    // (D-224), o que muda é a lente.
    needsPrices
      ? supabase
          .from("domain_events")
          .select("id, event_type, severity, occurred_at, before, after, entity_type")
          .eq("ml_account_id", row.ml_account_id)
          .eq("entity_type", "listing")
          .eq("entity_id", row.item_id)
          .eq("event_type", "listing.price.changed")
          .order("occurred_at", { ascending: false })
          .limit(TIMELINE_LIMIT)
      : Promise.resolve({ data: null, error: null }),
    // Republicações deste anúncio — como PAI (foi republicado) ou como FILHO
    // (nasceu de uma republicação). Só leitura: a tela nunca dispara relist.
    needsRelists
      ? supabase
          .from("listing_relists")
          .select("id, child_item_id, status, failure_reason, created_at, updated_at")
          .or(`parent_item_id.eq.${row.item_id},child_item_id.eq.${row.item_id}`)
          .order("created_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: null, error: null }),
    // Decisões registradas sobre AÇÕES deste anúncio (`actions.mlb_id`) — o
    // embed filtra pelo anúncio, não pelo SKU.
    needsDecisions
      ? supabase
          .from("action_decisions")
          .select("id, decision, baseline_snapshot, created_at, actions!inner(kind, status, recommendation, mlb_id)")
          .eq("actions.mlb_id", row.item_id)
          .order("created_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: null, error: null }),
  ]);

  const summary = summaryResult.data;
  // `full_quantity` é NULA sem snapshot recente (D-243): ausência não é zero.
  const linhaDoAnuncio = (fullDoAnuncioResult.data ?? []) as { full_quantity: number | null }[];
  const fullDoAnuncio = fullDoAnuncioResult.error === null ? (linhaDoAnuncio[0]?.full_quantity ?? null) : null;
  const full = fullResult.data;
  const timeline = (timelineResult.data ?? []) as unknown as TimelineEventRow[];
  const actions = actionsResult.data ?? [];
  const daily = (dailyResult.data ?? []) as unknown as DiaMetricaRow[];
  const visits = (visitsResult.data ?? []) as unknown as DiaVisitaRow[];
  const prices = (pricesResult.data ?? []) as unknown as TimelineEventRow[];
  const relists = (relistsResult.data ?? []) as unknown as RelistRow[];
  const decisions = (decisionsResult.data ?? []) as unknown as DecisionRow[];

  // Falha em qualquer consulta secundária aparece como ERRO, nunca como
  // "sem dado" (D-067).
  const secondaryError =
    summaryResult.error ??
    fullDoAnuncioResult.error ??
    fullResult.error ??
    timelineResult.error ??
    actionsResult.error ??
    dailyResult.error ??
    visitsResult.error ??
    pricesResult.error ??
    relistsResult.error ??
    decisionsResult.error;

  /*
   * Os selos vêm da MESMA linha já lida — nenhum custa ida nova. A ordem é a
   * do frame: estado primeiro, conta depois, e a pendência de vínculo por
   * último, porque ela é trabalho a fazer e não característica do anúncio.
   */
  const badges: ObjectBadge[] = [
    { label: listingStatusLabel(row.status), tom: tomDeStatus(statusTone(row.status)) },
    { label: row.ml_accounts.label, tom: "info" },
    ...(row.sku_id === null ? [{ label: "Sem vínculo de SKU", tom: "atencao" as const }] : []),
  ];

  const href = (key: TabKey): string =>
    key === "visao-geral" ? `/anuncios/${row.item_id}` : `/anuncios/${row.item_id}?aba=${key}`;

  return (
    <Shell>
      <PageTitle
        compacto
        eyebrow="COMERCIAL / CATÁLOGO"
        title="Detalhe do anúncio"
        subtitle="Estado, desempenho, Full e a história de um anúncio do Mercado Livre."
      />

      <ObjectHeader
        identificador={row.item_id}
        titulo={row.title}
        badges={badges}
        meta={`sincronizado em ${formatDateTime(row.synced_at)}`}
        acoes={
          <details className="sb-menu">
            <summary className="sb-button sb-button-primary">
              Ações
              <span aria-hidden="true" className="sb-menu-chevron">
                ⌄
              </span>
            </summary>
            <div className="sb-menu-panel" style={{ right: 0, left: "auto" }}>
              {row.sku_id === null ? (
                <Link className="sb-menu-item" href="/vinculacoes">
                  Vincular a um SKU
                </Link>
              ) : (
                <Link className="sb-menu-item" href={`/skus/${row.sku_id}`}>
                  Abrir o SKU {row.skus?.sku ?? ""}
                </Link>
              )}
              <Link className="sb-menu-item" href="/acoes">
                Ver ações abertas
              </Link>
              <Link className="sb-menu-item" href="/anuncios">
                Voltar ao catálogo
              </Link>
            </div>
          </details>
        }
        rotuloAbas="Abas do anúncio"
        abas={TAB_KEYS.map((key) => ({ href: href(key), label: TAB_LABELS[key], active: key === tab }))}
      >
        {secondaryError !== null && (
          <p role="alert" style={{ margin: "0 0 var(--sb-space-3)", color: "var(--sb-danger)", fontSize: "0.6875rem" }}>
            Não foi possível carregar parte do dashboard: {secondaryError.message}
          </p>
        )}

        {tab === "visao-geral" && (
          <>
            {/*
              Os QUATRO indicadores do frame, nesta ordem: Visitas, Conversão,
              Vendas, Faturamento. O bloco "Exposição em Risco" e o painel
              "Saúde do Anúncio" do frame ficam de fora — veredito sintetizado
              e competitividade/fotos não têm fonte; do que era "saúde" sobra o
              Full, que é medido e tem painel próprio abaixo.
            */}
            {summary !== null && (
              <div className="sb-stat-grid">
                <div className="sb-stat">
                  <span className="sb-stat-label">Visitas ({LOOKBACK_DAYS}d)</span>
                  <b className="sb-stat-value">{formatCount(summary.visits)}</b>
                  <span className="sb-stat-note">
                    {summary.days_observed === 0
                      ? "nenhum dia com coleta de visitas no período"
                      : `observadas em ${String(summary.days_observed)} de ${String(LOOKBACK_DAYS)} dias`}
                  </span>
                </div>

                <div className="sb-stat">
                  <span className="sb-stat-label">Conversão</span>
                  <b className="sb-stat-value">
                    {summary.conversion === null ? "—" : formatPercent(summary.conversion)}
                  </b>
                  <span className="sb-stat-note">
                    {summary.conversion === null
                      ? "sem visita observada — indefinida, não 0%"
                      : "pedidos ÷ visitas dos dias com coleta"}
                  </span>
                </div>

                {/*
                  O zero destes dois cartões vem de `coalesce(...,0)` na RPC, e
                  zero cru não diz de onde veio. `daily_listing_metrics` só
                  materializa dia com movimento — então "0" aqui significa
                  "nenhum dia com venda registrada", e é isso que a nota diz. É
                  a mesma doutrina de `/vendas` ("o recálculo não fabrica zero"),
                  que faltava nesta tela.
                */}
                <div className="sb-stat">
                  <span className="sb-stat-label">Vendas ({LOOKBACK_DAYS}d)</span>
                  <b className="sb-stat-value">{formatCount(summary.units_sold)}</b>
                  <span className="sb-stat-note">
                    {summary.units_sold === 0
                      ? "nenhum dia com venda registrada no período"
                      : `unidades em ${formatCount(summary.orders_count)} pedido(s)`}
                  </span>
                </div>

                <div className="sb-stat">
                  <span className="sb-stat-label">Faturamento ({LOOKBACK_DAYS}d)</span>
                  <b className="sb-stat-value">{formatCurrency(summary.gross_revenue)}</b>
                  <span className="sb-stat-note">
                    {summary.units_sold === 0
                      ? `sem venda registrada · preço atual ${formatCurrency(row.price)}`
                      : `receita bruta · preço atual ${formatCurrency(row.price)}`}
                  </span>
                </div>
              </div>
            )}

            <div className="sb-pair-grid">
              <Panel
                title="Full"
                subtitle="o que o Mercado Livre guarda deste item"
                aside={
                  <Link href="/full" style={{ color: "var(--sb-secondary)", textDecoration: "none", fontSize: "0.6875rem" }}>
                    Central Full →
                  </Link>
                }
              >
                <p className="sb-panel-body" style={{ margin: 0, fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
                  {fullDoAnuncio === null
                    ? "Sem snapshot de Full nos últimos 3 dias para este anúncio — ele não está no Full, ou a captura não o alcançou. Ausência de snapshot não é saldo zero."
                    : `${formatCount(fullDoAnuncio)} unidade(s) no Full deste anúncio — o mesmo número que a lista de anúncios mostra.`}
                </p>
              </Panel>

              <Panel
                title="Ações relacionadas"
                subtitle={`${formatCount(actions.length)} aberta(s) ou registrada(s) para este anúncio`}
                aside={
                  <Link href="/acoes" style={{ color: "var(--sb-secondary)", textDecoration: "none", fontSize: "0.6875rem" }}>
                    Central de Ações →
                  </Link>
                }
              >
                {actions.length === 0 ? (
                  <p className="sb-empty">Nenhuma ação registrada para este anúncio.</p>
                ) : (
                  actions.map((action) => (
                    <div key={action.id} className="sb-feed-row">
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <b>{action.recommendation}</b>
                        <small>
                          {action.kind} · {formatDateTime(action.created_at)}
                        </small>
                      </span>
                      <StatusPill code={action.status} label={actionStatusLabel(action.status)} />
                    </div>
                  ))
                )}
              </Panel>
            </div>
          </>
        )}

        {tab === "vendas" && (
          <>
            <div className="sb-section-label" style={{ marginTop: 0 }}>
              <span>Vendas do anúncio</span>
              <span className="sb-section-note">
                últimos {LOOKBACK_DAYS} dias · recálculo por dia, não leitura ao vivo
              </span>
            </div>

            {summary !== null && (
              <KpiStrip
                ancora
                cells={
                  [
                    {
                      metricId: "unidades_vendidas",
                      label: "Unidades vendidas",
                      formula: "SUM(order_items.quantity) no grão anúncio/dia",
                      value: formatCount(summary.units_sold),
                      previous: null,
                    },
                    {
                      metricId: "receita_bruta",
                      label: "Receita bruta",
                      formula: "SUM(orders.total_amount) — pedidos pagos ou parcialmente reembolsados",
                      value: formatCurrency(summary.gross_revenue),
                      previous: null,
                    },
                    {
                      metricId: "pedidos",
                      label: "Pedidos",
                      formula: "COUNT(DISTINCT orders.id)",
                      value: formatCount(summary.orders_count),
                      previous: null,
                    },
                  ] satisfies KpiCellData[]
                }
              />
            )}

            <div style={{ marginTop: "var(--sb-space-3)" }}>
              <Panel
                title="Por dia"
                subtitle="Dias sem venda registrada não aparecem — o recálculo não fabrica zero (mesmo contrato de /vendas)."
              >
                {daily.length === 0 ? (
                  <p className="sb-empty">Nenhum dia com venda registrada para este anúncio no período.</p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="sb-table">
                      <thead>
                        <tr>
                          <th>Dia</th>
                          <th className="sb-num">Unidades</th>
                          <th className="sb-num">Receita bruta</th>
                          <th className="sb-num">Pedidos</th>
                          <th className="sb-num">Compras</th>
                        </tr>
                      </thead>
                      <tbody>
                        {daily.map((linha) => (
                          <tr key={linha.metric_date}>
                            {/* Data de NEGÓCIO (YYYY-MM-DD): formatar por string,
                                nunca por `new Date` (deslocaria o dia civil). */}
                            <td style={{ whiteSpace: "nowrap" }}>{formatBusinessDate(linha.metric_date)}</td>
                            <td className="sb-num">{formatCount(linha.units_sold)}</td>
                            <td className="sb-num">{formatCurrency(linha.gross_revenue)}</td>
                            <td className="sb-num">{formatCount(linha.orders_count)}</td>
                            <td className="sb-num">{formatCount(linha.purchases_count)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </div>
          </>
        )}

        {tab === "trafego" && (
          <>
            <div className="sb-section-label" style={{ marginTop: 0 }}>
              <span>Tráfego do anúncio</span>
              <span className="sb-section-note">
                visitas coletadas por varredura, últimos {LOOKBACK_DAYS} dias
              </span>
            </div>

            {summary !== null && (
              <div className="sb-stat-grid" style={{ ["--sb-stat-cols" as string]: "3" }}>
                <div className="sb-stat">
                  <span className="sb-stat-label">Visitas</span>
                  <b className="sb-stat-value">{formatCount(summary.visits)}</b>
                  <span className="sb-stat-note" style={{ fontFamily: "var(--sb-mono)" }}>
                    visitas
                  </span>
                </div>

                <div className="sb-stat">
                  <span className="sb-stat-label">Dias observados</span>
                  <b className="sb-stat-value">
                    {summary.days_observed === 0
                      ? "—"
                      : `${String(summary.days_observed)}/${String(LOOKBACK_DAYS)}`}
                  </b>
                  <span className="sb-stat-note">
                    a varredura não alcança todo dia; é o denominador honesto da conversão
                  </span>
                </div>

                <div className="sb-stat">
                  <span className="sb-stat-label">Conversão</span>
                  <b className="sb-stat-value">
                    {summary.conversion === null ? "—" : formatPercent(summary.conversion)}
                  </b>
                  <span className="sb-stat-note" style={{ fontFamily: "var(--sb-mono)" }}>
                    taxa_conversao
                  </span>
                </div>
              </div>
            )}

            <div style={{ marginTop: "var(--sb-space-3)" }}>
              <Panel
                title="Visitas por dia"
                subtitle="Só os dias em que a varredura coletou. Ausência de linha é ausência de coleta, não visita zero (D-123)."
              >
                {visits.length === 0 ? (
                  <p className="sb-empty">
                    Nenhum dia com coleta de visitas para este anúncio no período — a varredura ainda não o alcançou.
                  </p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="sb-table">
                      <thead>
                        <tr>
                          <th>Dia</th>
                          <th className="sb-num">Visitas</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visits.map((linha) => (
                          <tr key={linha.metric_date}>
                            <td style={{ whiteSpace: "nowrap" }}>{formatBusinessDate(linha.metric_date)}</td>
                            <td className="sb-num">{formatCount(linha.visits)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </div>
          </>
        )}

        {tab === "preco" && (
          <Panel
            title="Mudanças de preço observadas"
            subtitle={`Preço atual ${formatCurrency(row.price)}. As mudanças são o DIFF entre duas sincronizações de 6 em 6 horas — uma alteração feita e desfeita entre elas não deixa registro.`}
          >
            {prices.length === 0 ? (
              <p className="sb-empty">
                Nenhuma mudança de preço observada neste anúncio. Não quer dizer preço parado: quer dizer que
                nenhuma sincronização viu duas etiquetas diferentes.
              </p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th>Quando</th>
                      <th>Mudança</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prices.map((evento) => (
                      <tr key={evento.id}>
                        <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(evento.occurred_at)}</td>
                        <td>{formatEventDiff(evento.event_type, evento.before, evento.after) ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        )}

        {tab === "full" && (
          <Panel
            title="Full deste anúncio"
            subtitle="O saldo do Full é espelhado por SKU e CONTA, somado por bucket de variação (D-173) — não por anúncio."
            aside={
              <Link href="/full" style={{ color: "var(--sb-secondary)", textDecoration: "none", fontSize: "0.6875rem" }}>
                Central Full →
              </Link>
            }
          >
            <div className="sb-panel-body">
              <div className="sb-stat-grid" style={{ ["--sb-stat-cols" as string]: "2" }}>
                <div className="sb-stat">
                  <span className="sb-stat-label">No Full (este anúncio)</span>
                  <b className="sb-stat-value">{fullDoAnuncio === null ? "—" : formatCount(fullDoAnuncio)}</b>
                  <span className="sb-stat-note">
                    {fullDoAnuncio === null
                      ? "sem snapshot nos últimos 3 dias — ausência, não zero"
                      : "último snapshot por bucket, o mesmo número da lista"}
                  </span>
                </div>

                <div className="sb-stat">
                  <span className="sb-stat-label">SKU vinculado</span>
                  <b className="sb-stat-value">{row.skus === null ? "—" : row.skus.sku}</b>
                  <span className="sb-stat-note">
                    {row.skus === null ? "sem vínculo — o Full por SKU não é rastreável" : "o Full por SKU e conta está abaixo"}
                  </span>
                </div>
              </div>
            </div>

            {row.sku_id === null ? (
              <p className="sb-empty">
                Sem vínculo de SKU — o quadro por SKU e conta não é rastreável até vincular.{" "}
                <Link href="/vinculacoes">Central de Vinculações</Link>.
              </p>
            ) : full === null ? (
              <p className="sb-empty">
                {/*
                  TRÊS causas, não duas: a leitura canônica só enxerga captura
                  dos últimos 3 dias (D-173), então "sem linha" pode ser um
                  saldo antigo que a varredura não recapturou. A frase anterior
                  declarava só duas e negava esta.
                */}
                Nenhum snapshot de Full para este SKU nesta conta nos últimos 3 dias — o item não está no Full,
                nunca foi capturado, ou a captura não o alcançou nesse prazo. Ausência de snapshot não é o mesmo
                que saldo zero.
              </p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th>Conta</th>
                      <th className="sb-num">No Full</th>
                      <th className="sb-num">Buckets</th>
                      <th className="sb-num">Local (org.)</th>
                      <th className="sb-num">Vendas {LOOKBACK_DAYS}d</th>
                      <th>Situação</th>
                      <th>Capturado</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{full.account_label}</td>
                      <td className="sb-num">{formatCount(full.full_quantity)}</td>
                      <td className="sb-num">{formatCount(full.buckets)}</td>
                      <td className="sb-num">{formatCount(full.local_quantity)}</td>
                      <td className="sb-num">{formatCount(full.units_sold)}</td>
                      <td title={fullSituationCriterion(full.situation)}>
                        <span className="sb-status" style={TOM[fullSituationTom(full.situation)]}>
                          {fullSituationLabel(full.situation)}
                        </span>
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(full.captured_at)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        )}

        {tab === "historico" && (
          <>
            {/*
              Linha do tempo DESTE anúncio — recorte por entidade, não duplicata
              da timeline do SKU (que agrega três caminhos). História, nunca
              causa.
            */}
            <Panel
              title="Linha do tempo do anúncio"
              subtitle={
                timeline.length >= TIMELINE_LIMIT
                  ? `os ${String(TIMELINE_LIMIT)} eventos mais recentes`
                  : "eventos de domínio registrados para este item"
              }
            >
              {timeline.length === 0 ? (
                <p className="sb-empty">
                  Nenhum evento registrado para este anúncio — a linha do tempo nasce dos eventos de domínio e só
                  enxerga o que o sistema registrou.
                </p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="sb-table">
                    <thead>
                      {/*
                        Sem coluna "Onde": a consulta fixa `entity_type =
                        'listing'`, então ela imprimia "Anúncio" em toda linha —
                        uma coluna inteira para repetir o título da seção.
                      */}
                      <tr>
                        <th>Quando</th>
                        <th>Evento</th>
                        <th>Mudança</th>
                      </tr>
                    </thead>
                    <tbody>
                      {timeline.map((entry) => (
                        <tr key={entry.id}>
                          <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(entry.occurred_at)}</td>
                          <td>
                            <span
                              style={
                                entry.severity === "critico"
                                  ? { color: "var(--sb-danger)", fontWeight: 600 }
                                  : entry.severity === "importante"
                                    ? { color: "var(--sb-accent-ink)" }
                                    : undefined
                              }
                            >
                              {eventTypeLabel(entry.event_type)}
                            </span>
                          </td>
                          <td>{formatEventDiff(entry.event_type, entry.before, entry.after) ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            {/*
              REPUBLICAÇÃO — a fila que a fatia D13 original queria como tela
              própria. Ela não é tela: é a história deste anúncio. A tela LÊ e
              não dispara: a primeira republicação real é ato humano deliberado
              (`docs/HANDOFF.md`), e o motor vive no worker e na API.
            */}
            <div style={{ marginTop: "var(--sb-space-3)" }}>
              <Panel
                title="Republicações"
                subtitle="Como pai (foi republicado) ou como filho (nasceu de uma republicação). Esta tela lê o histórico; republicar é ato humano deliberado, fora da interface."
              >
                {relists.length === 0 ? (
                  <p className="sb-empty">Nenhuma republicação registrada para este anúncio.</p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="sb-table">
                      <thead>
                        <tr>
                          <th>Pedida em</th>
                          <th>Estado</th>
                          <th>Anúncio filho</th>
                          <th>Motivo da falha</th>
                          <th>Atualizada em</th>
                        </tr>
                      </thead>
                      <tbody>
                        {relists.map((relist) => (
                          <tr key={relist.id}>
                            <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(relist.created_at)}</td>
                            <td>
                              <span className="sb-status" style={TOM[relistTom(relist.status)]}>
                                {relist.status}
                              </span>
                            </td>
                            <td className="sb-mono">
                              {relist.child_item_id === null ? (
                                "—"
                              ) : (
                                <Link href={`/anuncios/${relist.child_item_id}`}>{relist.child_item_id}</Link>
                              )}
                            </td>
                            <td style={{ color: relist.failure_reason === null ? undefined : "var(--sb-danger)" }}>
                              {relist.failure_reason ?? "—"}
                            </td>
                            <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(relist.updated_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </div>
          </>
        )}

        {tab === "diagnostico" && (
          <Panel title="Diagnóstico de venda" subtitle="por que esta aba não calcula nada aqui">
            {/*
              RECUSA HONESTA. O diagnóstico de venda anômala (D-078) compara a
              venda de ontem com o mesmo dia da semana usando
              `get_sku_sales_baseline` — baseline de SKU. Não existe baseline
              por ANÚNCIO, e rodar a fórmula sobre `daily_listing_metrics`
              produziria um número com a mesma cara e outra definição: a classe
              de invenção que D-023 proíbe.
            */}
            <div className="sb-panel-body" style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
              <p style={{ margin: "0 0 var(--sb-space-2)" }}>
                O diagnóstico de venda anômala compara a venda de ontem com o mesmo dia da semana sobre a{" "}
                <strong>baseline do SKU</strong>. Não existe baseline por anúncio, e aplicar a mesma fórmula ao
                recálculo por anúncio daria um número com a mesma cara e outra definição.
              </p>
              <p style={{ margin: 0 }}>
                {row.sku_id === null ? (
                  <>
                    Este anúncio não tem SKU vinculado, então nem por lá é possível diagnosticar. A fila de
                    vínculos está na <Link href="/vinculacoes">Central de Vinculações</Link>.
                  </>
                ) : (
                  <>
                    O diagnóstico deste item vive no SKU que ele vende:{" "}
                    <Link href={`/skus/${row.sku_id}?aba=diagnostico`}>
                      abrir o diagnóstico de {row.skus?.sku ?? "SKU"}
                    </Link>
                    .
                  </>
                )}
              </p>
            </div>
          </Panel>
        )}

        {tab === "decisoes" && (
          <Panel
            title="Decisões registradas"
            subtitle="Cada decisão nasce de uma ação da Central de Ações e guarda o retrato do momento. Comparação bruta, nunca porcentagem de resultado."
            aside={
              <Link href="/acoes" style={{ color: "var(--sb-secondary)", textDecoration: "none", fontSize: "0.6875rem" }}>
                Central de Ações →
              </Link>
            }
          >
            {decisions.length === 0 ? (
              <p className="sb-empty">
                Nenhuma decisão registrada para este anúncio. Uma decisão nasce de uma ação em{" "}
                <Link href="/acoes">Ações</Link>, e é ela que permite medir o depois contra o antes.
              </p>
            ) : (
              <div style={{ margin: "0 calc(-1 * var(--sb-space-3))" }}>
                {decisions.map((decision) => (
                  <article
                    key={decision.id}
                    className="sb-panel-body"
                    style={{ borderTop: "1px solid var(--sb-border)" }}
                  >
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", flexWrap: "wrap" }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <b style={{ display: "block", fontSize: "0.75rem" }}>{decision.decision}</b>
                        <small
                          style={{ display: "block", marginTop: 3, fontSize: "0.625rem", color: "var(--sb-text-soft)" }}
                        >
                          {decision.actions?.kind ?? "ação"} · {formatDateTime(decision.created_at)}
                        </small>
                      </span>
                      {decision.actions !== null && (
                        <StatusPill
                          code={decision.actions.status}
                          label={actionStatusLabel(decision.actions.status)}
                        />
                      )}
                    </div>

                    <p style={{ margin: "var(--sb-space-2) 0 0", fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
                      No momento da decisão — {formatDecisionSnapshot(decision.baseline_snapshot)}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </Panel>
        )}
      </ObjectHeader>
    </Shell>
  );
}
