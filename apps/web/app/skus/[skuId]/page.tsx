import { describeActionEvidence } from "@sb/domain";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { KpiStrip, type KpiCellData } from "../../../components/kpi-strip";
import { ObjectHeader, type ObjectBadge } from "../../../components/object-header";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { TOM } from "../../../components/tone";
import { Shell } from "../../../components/shell";
import { StatusPill } from "../../../components/status-pill";
import { formatDecisionSnapshot, OUTCOME_WINDOWS_DAYS, outcomeWindowLabel } from "../../../lib/decision-format";
import { entityLabel, formatEventDiff } from "../../../lib/event-format";
import {
  formatBusinessDate,
  formatCount,
  formatCurrency,
  formatDateTime,
  formatPercent,
} from "../../../lib/format";
import { actionStatusLabel, eventTypeLabel, listingStatusLabel } from "../../../lib/labels";
import { fullSituationCriterion, fullSituationLabel } from "../../../lib/full-filters";
import { createClient } from "../../../lib/supabase/server";
import { DiagnosisPanel } from "./diagnosis-panel";
import { SimulatorPanel } from "./simulator-panel";

export const metadata = { title: "Dashboard de SKU — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * "Dashboard de SKU" (Fase 5B) em ABAS (D-169), no escopo final de NOVE abas
 * de D-224 — progressive disclosure alinhado ao Figma: cada aba só dispara as
 * consultas de que precisa (o resto vira `Promise.resolve`).
 *
 * Ordem e nomes são os aprovados em D-224:
 * `Visão geral | Vendas | Estoque | Anúncios | Preços | Full | Histórico | Diagnóstico | Decisões`.
 * `Tráfego` e `Atendimento` saíram lá, com motivo escrito. `Full` (D-225) e
 * `Preços` (D-226) saíram por reuso de RPC existente. `Vendas` (D-227) é a
 * única com RPC própria — `get_sku_sales_breakdown` devolve TOTAL, por CONTA
 * e por DIA num único round trip (grouping sets no banco): a regra
 * inegociável é agregar em SQL (docs/ARCHITECTURE.md secao 15), e D-185 mediu
 * que o custo de uma chamada é a viagem, não o SQL. `Decisões` (D-228) é
 * leitura direta sob RLS — `action_decisions` com o embed `actions!inner`
 * filtrado pelo SKU da ação, num round trip — e o estado vazio É a tela:
 * havia UMA decisão registrada em todo o Dev quando ela nasceu.
 *
 * A aba vive na URL (`?aba=`, mesmo padrão dos filtros de Movimentações):
 * valor fora do conjunto fechado cai para a Visão geral antes de tocar o
 * banco. Janela FIXA de 30 dias, mesma convenção de /cobertura.
 */

const LOOKBACK_DAYS = 30;

/** A linha do tempo mostra os últimos N — e diz isso quando o corte agiu. */
const TIMELINE_LIMIT = 50;

// Na ordem aprovada em D-224 (Preços ANTES de Full — a ordem anterior estava
// trocada em relação ao PRD).
const TAB_KEYS = [
  "visao-geral",
  "vendas",
  "estoque",
  "anuncios",
  "precos",
  "full",
  "historico",
  "diagnostico",
  "decisoes",
] as const;
type TabKey = (typeof TAB_KEYS)[number];

const TAB_LABELS: Record<TabKey, string> = {
  "visao-geral": "Visão geral",
  vendas: "Vendas",
  estoque: "Estoque",
  anuncios: "Anúncios",
  precos: "Preços",
  full: "Full",
  historico: "Histórico",
  diagnostico: "Diagnóstico",
  decisoes: "Decisões",
};

function parseTab(value: string | string[] | undefined): TabKey {
  return typeof value === "string" && (TAB_KEYS as readonly string[]).includes(value)
    ? (value as TabKey)
    : "visao-geral";
}

/**
 * Nulidade real conferida contra o corpo da RPC (o gerador não marca
 * `account_label` do left join como anulável) — mesmo padrão das demais
 * telas.
 */
interface TimelineRow {
  id: string;
  occurred_at: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  severity: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  account_label: string | null;
}


function StockBoxes({
  dashboard,
}: {
  dashboard: {
    local_quantity: number;
    reservado_quantity: number;
    transito_quantity: number;
    full_quantity: number;
  };
}): ReactNode {
  return (
    <div className="sb-stat-grid" style={{ marginBottom: "var(--sb-space-3)" }}>
      {[
        { rotulo: "Local", valor: dashboard.local_quantity, nota: "saldo físico da organização" },
        { rotulo: "Reservado", valor: dashboard.reservado_quantity, nota: "comprometido com pedido" },
        { rotulo: "Em trânsito", valor: dashboard.transito_quantity, nota: "comprado e ainda não recebido" },
        { rotulo: "Full", valor: dashboard.full_quantity, nota: "no centro do Mercado Livre" },
      ].map((caixa) => (
        <div className="sb-stat" key={caixa.rotulo}>
          <span className="sb-stat-label">{caixa.rotulo}</span>
          <b className="sb-stat-value">{formatCount(caixa.valor)}</b>
          <span className="sb-stat-note">{caixa.nota}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Os SEIS números canônicos de venda no grão SKU (docs/METRICS.md 5.2), lidos
 * da linha `total` de `get_sku_sales_breakdown`. Nenhuma métrica nova: são os
 * mesmos ids de `/vendas`, e a RPC é a implementação deles neste grão. As
 * duas razões chegam calculadas sobre as SOMAS no banco (nunca média de
 * médias diárias) e vêm NULL com denominador zero — `formatCurrency(null)`
 * imprime "—", não R$ 0,00.
 */
interface SalesTotals {
  units_sold: number;
  gross_revenue: number;
  orders_count: number;
  purchases_count: number;
  average_ticket: number | null;
  average_selling_price: number | null;
}

interface SalesCard {
  metricId: string;
  label: string;
  formula: string;
  value: string;
}

function buildSalesCards(total: SalesTotals): SalesCard[] {
  return [
    {
      metricId: "unidades_vendidas",
      label: "Unidades vendidas",
      formula: "SUM(order_items.quantity)",
      value: formatCount(total.units_sold),
    },
    {
      metricId: "receita_bruta",
      label: "Receita bruta",
      formula: "SUM(orders.total_amount) — pedidos pagos ou parcialmente reembolsados",
      value: formatCurrency(total.gross_revenue),
    },
    {
      metricId: "pedidos",
      label: "Pedidos",
      formula: "COUNT(DISTINCT orders.id)",
      value: formatCount(total.orders_count),
    },
    {
      metricId: "pedidos_por_pack",
      label: "Compras (por pack)",
      formula: "COUNT(DISTINCT pack_id, com order_id como fallback)",
      value: formatCount(total.purchases_count),
    },
    {
      metricId: "ticket_medio",
      label: "Ticket médio",
      formula: "receita_bruta / pedidos_por_pack",
      value: formatCurrency(total.average_ticket),
    },
    {
      metricId: "preco_medio_praticado",
      label: "Preço médio praticado",
      formula: "receita_bruta / unidades_vendidas",
      value: formatCurrency(total.average_selling_price),
    },
  ];
}

/**
 * Os seis números como UMA faixa de KPIs — a mesma apresentação que `/vendas`
 * dá às mesmas métricas (mesmos ids canônicos). Eram seis cartões soltos em
 * `auto-fit`, que a 1440px quebravam em 5 + 1 órfão; a auditoria de
 * fidelidade apontou, e o design system já tinha a resposta.
 */
function salesCells(total: SalesTotals): KpiCellData[] {
  return buildSalesCards(total).map((card) => ({
    metricId: card.metricId,
    label: card.label,
    formula: card.formula,
    value: card.value,
    previous: null,
  }));
}

export default async function SkuDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ skuId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { skuId } = await params;
  const query = await searchParams;
  const tab = parseTab(query.aba);

  const supabase = await createClient();

  const sku = await supabase
    .from("skus")
    .select(
      // Os campos dos SELOS vêm da MESMA linha — zero ida a mais
      // (D-185: o custo é o round trip). `brand` é a CATEGORIA do UpSeller
      // (D-129) e por isso não vira selo de marca; quem é marca é
      // `supplier_brand`, que é decisão humana.
      "id, sku, title, organization_id, purchase_cost, is_active, is_discontinued, is_imported, stock_is_virtual, supplier_brand, updated_at",
    )
    .eq("id", skuId)
    .maybeSingle();

  // `null` aqui pode ser "não existe" ou "a policy escondeu" — mesmo
  // raciocínio já usado em apps/web/app/compras/[id]/page.tsx.
  if (sku.error !== null || sku.data === null) {
    notFound();
  }

  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - (LOOKBACK_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Cada aba só dispara as consultas de que precisa (progressive disclosure
  // de verdade, não só visual); o que a aba ativa não usa vira
  // Promise.resolve — mesmo padrão do Full no Dashboard de Anúncio.
  const needsDashboard = tab === "visao-geral" || tab === "estoque";
  const needsListings = tab === "visao-geral" || tab === "anuncios";
  const needsHistory = tab === "historico";
  const needsFull = tab === "full";
  const needsPrices = tab === "precos";
  const needsSales = tab === "vendas";
  const needsDecisions = tab === "visao-geral" || tab === "decisoes";

  const [
    dashboardResult,
    listingsResult,
    coverageResult,
    costHistoryResult,
    timelineResult,
    fullResult,
    pricesResult,
    salesResult,
    decisionsResult,
    openActionsResult,
  ] = await Promise.all([
    needsDashboard
      ? supabase
          .rpc("get_sku_dashboard", {
            p_organization_id: sku.data.organization_id,
            p_sku_id: sku.data.id,
            p_date_from: dateFrom,
            p_date_to: dateTo,
          })
          .single()
      : Promise.resolve({ data: null, error: null }),
    needsListings
      ? supabase
          .from("listings")
          .select("id, item_id, title, status, price, ml_accounts(label)")
          .eq("sku_id", sku.data.id)
          .order("title")
      : Promise.resolve({ data: null, error: null }),
    // Mesma janela de 30 dias do resumo — venda média diária real, só para
    // pré-preencher a premissa do simulador (D-080); o usuário pode ajustar
    // livremente a partir daí.
    // Em TODAS as abas: o cabeçalho de entidade precisa da cobertura para o
    // "Risco de ruptura" (o botão em tom de perigo do frame) — uma linha por
    // SKU, custo desprezível dentro do mesmo `Promise.all`.
    supabase
      .rpc("get_stock_coverage", {
        p_organization_id: sku.data.organization_id,
        p_date_from: dateFrom,
        p_date_to: dateTo,
        p_sku_id: sku.data.id,
      })
      .maybeSingle(),
    // Histórico de custo cadastrado (D-149) — alimentado por trigger a cada
    // mudança de `skus.purchase_cost`. Sem backfill: o registro começa em
    // 30/08/2026 e a tela diz isso.
    needsHistory
      ? supabase
          .from("sku_cost_history")
          .select("id, previous_cost, new_cost, changed_by_role, changed_at")
          .eq("sku_id", sku.data.id)
          .order("changed_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: null, error: null }),
    // Linha do tempo (D-153): todos os eventos mapeáveis ao SKU — dele, dos
    // seus anúncios e dos seus pedidos. História, não causa: aqui o
    // vocabulário é ABERTO (contrato oposto ao da correlação de D-152).
    needsHistory
      ? supabase.rpc("get_sku_timeline", {
          p_organization_id: sku.data.organization_id,
          p_sku_id: sku.data.id,
          p_limit: TIMELINE_LIMIT,
        })
      : Promise.resolve({ data: null, error: null }),
    // Full por CONTA (D-224). Reusa `get_fulfillment_overview`, que já aceita
    // `p_sku_id` desde D-173 — nenhuma RPC nova, e o grão certo vem de graça:
    // a soma é por bucket `inventory_id`, que é o achado que D-173 mediu em
    // 15,6% de unidades a menos quando se colapsa por (sku, conta).
    // `p_limit` pequeno porque um SKU existe em poucas contas.
      needsFull
        ? supabase.rpc("get_fulfillment_overview", {
            p_organization_id: sku.data.organization_id,
            p_date_from: dateFrom,
            p_date_to: dateTo,
            p_ml_account_id: null,
            p_situation: null,
            p_search: null,
            p_sku_id: sku.data.id,
            p_limit: 20,
            p_offset: 0,
          })
        : Promise.resolve({ data: null, error: null }),
    // Preços (D-226). Reusa `get_price_changes` de D-172, que ganhou
    // `p_sku_id` — nenhuma RPC nova. A janela aqui é a MESMA de 30 dias das
    // outras abas, e não a de 7 dias da Central de Preços: a pergunta desta
    // tela é "o que aconteceu com este SKU no período que a página inteira
    // está mostrando", não "o que mudou esta semana na operação".
    needsPrices
      ? supabase.rpc("get_price_changes", {
          p_organization_id: sku.data.organization_id,
          // As demais RPCs desta página recebem `p_date_to` como DIA e o
          // tratam como inclusivo. `get_price_changes` não: ela recebe
          // timestamptz e corta em `occurred_at < p_date_to`. Passar
          // `dateTo` cru esconderia as mudanças de HOJE, sem erro nenhum na
          // tela. O +1 dia é a mesma correção que /precos já faz.
          p_date_from: `${dateFrom}T00:00:00Z`,
          p_date_to: new Date(new Date(`${dateTo}T00:00:00Z`).getTime() + 86_400_000).toISOString(),
          p_ml_account_id: null,
          p_direction: null,
          p_search: null,
          p_sku_id: sku.data.id,
          p_limit: 50,
          p_offset: 0,
        })
      : Promise.resolve({ data: null, error: null }),
    // Vendas (D-227). A única aba com RPC própria: `get_sku_sales_breakdown`
    // devolve TOTAL, por CONTA e por DIA numa chamada só (grouping sets no
    // banco). Três perguntas, um round trip (D-185) — e nenhuma soma em
    // JavaScript: as razões já chegam calculadas sobre as somas.
    needsSales
      ? supabase.rpc("get_sku_sales_breakdown", {
          p_organization_id: sku.data.organization_id,
          p_sku_id: sku.data.id,
          p_date_from: dateFrom,
          p_date_to: dateTo,
        })
      : Promise.resolve({ data: null, error: null }),
    // Decisões (D-228). Leitura direta sob RLS, sem RPC: `action_decisions`
    // com o embed `actions!inner` (o SKU vive na AÇÃO, não na decisão) e o
    // embed reverso `action_outcomes`. As três tabelas têm a MESMA policy
    // (`organization_id in (select private.accessible_orgs())`, a forma de
    // conjunto de D-181), então o embed não volta nulo para
    // linha visível (a regra de D-206) — e `!inner` faz o filtro pelo SKU
    // descartar a decisão inteira, nunca anular a ação. Sem cast.
    needsDecisions
      ? supabase
          .from("action_decisions")
          .select(
            "id, decision, baseline_snapshot, created_at, actions!inner(id, kind, status, evidence, recommendation), action_outcomes(window_days, outcome_snapshot, measured_at)",
          )
          .eq("actions.sku_id", sku.data.id)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: null, error: null }),
    // Quantas ações ABERTAS este SKU tem — contado no BANCO (`head: true`
    // devolve só o count), não em JS. Medido em 03/09/2026: máximo de 8
    // ações por SKU, então caberia contar em JS; a regra não é sobre o
    // tamanho de hoje.
    needsDecisions
      ? supabase
          .from("actions")
          .select("id", { count: "exact", head: true })
          .eq("sku_id", sku.data.id)
          .in("status", ["novo", "em_andamento"])
      : Promise.resolve({ data: null, error: null, count: null }),
  ]);

  const dashboard = dashboardResult.data;
  const listings = listingsResult.data ?? [];
  const coverage = coverageResult.data;
  const costHistory = costHistoryResult.data ?? [];
  const timeline = (timelineResult.data ?? []) as unknown as TimelineRow[];
  const full = fullResult.data ?? [];
  const prices = pricesResult.data ?? [];
  const sales = salesResult.data ?? [];
  // Particionar as (no máximo) 1 + contas + 30 linhas por `grain` não é
  // agregar: as somas e razões vieram prontas do banco.
  const salesTotal = sales.find((linha) => linha.grain === "total") ?? null;
  const salesByAccount = sales.filter((linha) => linha.grain === "conta");
  const salesByDay = sales.filter((linha) => linha.grain === "dia");
  const decisions = decisionsResult.data ?? [];
  const openActions = openActionsResult.count ?? null;

  /*
   * Os selos do cabeçalho de entidade. Todos vêm da linha de `skus` já lida —
   * nenhum é decorativo e nenhum custa ida nova. A ordem é a do frame: estado
   * primeiro, classificação depois, procedência por último.
   */
  /*
   * O tom do cartão de cobertura. Só existe quando o estado MERECE tom: em
   * ruptura é perigo, virtual é atenção (o número está em branco de propósito),
   * e o resto é o cartão neutro. Pintar todos seria ruído.
   */
  const coberturaTom =
    coverage === null
      ? null
      : coverage.is_ruptura
        ? "var(--sb-danger)"
        : coverage.stock_is_virtual
          ? "var(--sb-accent-ink)"
          : null;

  const badges: ObjectBadge[] = [
    sku.data.is_discontinued
      ? { label: "Descontinuado", tom: "perigo" as const }
      : sku.data.is_active
        ? { label: "Ativo", tom: "ok" as const }
        : { label: "Inativo", tom: "neutro" as const },
    ...(sku.data.stock_is_virtual ? [{ label: "Estoque virtual", tom: "atencao" as const }] : []),
    ...(sku.data.supplier_brand !== null ? [{ label: sku.data.supplier_brand, tom: "info" as const }] : []),
    ...(sku.data.is_imported ? [{ label: "Importado", tom: "neutro" as const }] : []),
  ];

  return (
    <Shell>
      {/*
        Como no frame: a página abre com um cabeçalho de página (sobrancelha +
        "Detalhe do SKU" + uma linha), e o cartão de entidade vem abaixo com o
        nome do produto como título do cartão. O h1 da tela é o cabeçalho.
      */}
      <PageTitle
        compacto
        eyebrow="CATÁLOGO / DETALHE DO PRODUTO"
        title="Detalhe do SKU"
        subtitle="Visão completa de performance, estoque e histórico."
      />

      <ObjectHeader
        identificador={`SKU ${sku.data.sku}`}
        titulo={sku.data.title ?? sku.data.sku}
        badges={badges}
        meta={`atualizado em ${formatDateTime(sku.data.updated_at)}`}
        acoes={
          <>
            {/*
              O ESTADO como ação, como no frame ("Risco de Ruptura !" em tom de
              perigo): só aparece quando a cobertura diz ruptura, e leva à tela
              que explica. Nunca decorativo.
            */}
            {coverage?.is_ruptura === true && (
              <Link
                href="/cobertura"
                className="sb-button"
                style={{ color: "var(--sb-danger)", borderColor: "var(--sb-danger)" }}
              >
                Risco de ruptura
                <span className="sb-status" style={TOM.perigo}>
                  !
                </span>
              </Link>
            )}
            {/* "Ações ⌄" — o menu primário do frame, com as ações REAIS do SKU. */}
            <details className="sb-menu">
              <summary className="sb-button sb-button-primary">
                Ações
                <span aria-hidden="true" className="sb-menu-chevron">
                  ⌄
                </span>
              </summary>
              <div className="sb-menu-panel" style={{ right: 0, left: "auto" }}>
                <Link className="sb-menu-item" href={`/estoque/${skuId}/ajuste`}>
                  Ajustar estoque
                </Link>
                <Link className="sb-menu-item" href="/acoes">
                  Registrar decisão na Central de Ações
                </Link>
                <Link className="sb-menu-item" href="/cobertura">
                  Ver cobertura
                </Link>
                <Link className="sb-menu-item" href="/estoque">
                  Voltar ao estoque
                </Link>
              </div>
            </details>
          </>
        }
        abas={TAB_KEYS.map((key) => ({
          href: key === "visao-geral" ? `/skus/${skuId}` : `/skus/${skuId}?aba=${key}`,
          label: TAB_LABELS[key],
          active: key === tab,
        }))}
      >

      {tab === "visao-geral" && (
        <>
          {dashboardResult.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar o resumo: {dashboardResult.error.message}
            </p>
          )}

          {dashboard !== null && (
            <>
              {/*
                Os quatro indicadores do frame. O terceiro leva BORDA NO TOM
                quando o estado importa — é o gesto do `.attention-card`, aqui
                aplicado ao número que decide reposição.

                **Estoque não vira soma.** O frame mostra "Estoque Total 32 un ·
                29 Local · 3 Full"; somar Local + Reservado + Trânsito + Full
                seria um agregado que o sistema não define, e agregado sem
                definição é a classe de número que este projeto recusa. O
                cartão mostra o LOCAL — o saldo físico da organização — e a
                nota carrega os outros três, sem perder nenhum.
              */}
              <div className="sb-stat-grid">
                <div className="sb-stat">
                  <span className="sb-stat-label">Vendas ({LOOKBACK_DAYS}d)</span>
                  <b className="sb-stat-value">{formatCount(dashboard.units_sold)}</b>
                  <span className="sb-stat-note">unidades de pedidos válidos</span>
                </div>

                <div className="sb-stat">
                  <span className="sb-stat-label">Faturamento ({LOOKBACK_DAYS}d)</span>
                  <b className="sb-stat-value">{formatCurrency(dashboard.gross_revenue)}</b>
                  <span className="sb-stat-note">
                    receita bruta —{" "}
                    {sku.data.purchase_cost === null
                      ? "sem custo cadastrado"
                      : `custo cadastrado ${formatCurrency(sku.data.purchase_cost)}`}
                  </span>
                </div>

                <div
                  className="sb-stat"
                  style={
                    coberturaTom === null
                      ? undefined
                      : { ["--sb-tone" as string]: coberturaTom, ["--sb-tone-ink" as string]: coberturaTom }
                  }
                >
                  <span className="sb-stat-label">Cobertura</span>
                  <b className="sb-stat-value">
                    {coverage?.days_of_coverage == null
                      ? "—"
                      : `${formatCount(Math.round(coverage.days_of_coverage))} dias`}
                  </b>
                  <span className="sb-stat-note">
                    {coverage === null
                      ? "não calculada para este SKU"
                      : coverage.stock_is_virtual
                        ? "em branco de propósito: o saldo do ERP é sentinela, não contagem (D-127)"
                        : coverage.is_ruptura
                          ? "em ruptura — vende e está sem saldo para vender"
                          : `venda média de ${formatCount(Math.round((coverage.avg_daily_sales ?? 0) * 10) / 10)}/dia`}
                  </span>
                </div>

                <div className="sb-stat">
                  <span className="sb-stat-label">Estoque local</span>
                  <b className="sb-stat-value">{formatCount(dashboard.local_quantity)}</b>
                  <span className="sb-stat-note">
                    {formatCount(dashboard.reservado_quantity)} reservado ·{" "}
                    {formatCount(dashboard.transito_quantity)} em trânsito ·{" "}
                    {formatCount(dashboard.full_quantity)} no Full
                  </span>
                </div>
              </div>

              {/*
                Os dois painéis do frame. Eles não substituem as abas: são o
                atalho para o que se olha primeiro, e cada um leva à aba dona do
                assunto — "um dado, um dono" (D-224).
              */}
              <div className="sb-pair-grid">
                <Panel
                  title="Anúncios vinculados"
                  subtitle={
                    listingsResult.error !== null
                      ? "não foi possível carregar"
                      : `${formatCount(listings.length)} ${listings.length === 1 ? "anúncio" : "anúncios"} deste SKU`
                  }
                  aside={
                    <Link href={`/skus/${skuId}?aba=anuncios`} style={{ color: "var(--sb-secondary)", textDecoration: "none" }}>
                      Ver aba →
                    </Link>
                  }
                >
                  {listings.length === 0 ? (
                    <p style={{ margin: 0, padding: "var(--sb-space-3)", color: "var(--sb-text-soft)", fontSize: "0.6875rem" }}>
                      Nenhum anúncio vinculado a este SKU.
                    </p>
                  ) : (
                    listings.slice(0, 4).map((linha) => (
                      <div key={linha.id} className="sb-feed-row">
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <b style={{ display: "block", fontFamily: "var(--sb-mono)", fontSize: "0.625rem" }}>
                            {linha.item_id}
                          </b>
                          <small style={{ display: "block", marginTop: 3, fontSize: "0.5625rem", color: "var(--sb-text-soft)" }}>
                            {linha.ml_accounts.label}
                          </small>
                        </span>
                        <span style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <b style={{ display: "block", fontSize: "0.625rem" }}>{formatCurrency(linha.price)}</b>
                          <StatusPill code={linha.status} label={listingStatusLabel(linha.status)} />
                        </span>
                      </div>
                    ))
                  )}
                </Panel>

                <Panel
                  title="Últimas decisões"
                  subtitle={
                    decisionsResult.error !== null
                      ? "não foi possível carregar"
                      : `${formatCount(decisions.length)} registrada(s) para este SKU`
                  }
                  aside={
                    <Link href={`/skus/${skuId}?aba=decisoes`} style={{ color: "var(--sb-secondary)", textDecoration: "none" }}>
                      Ver aba →
                    </Link>
                  }
                >
                  {decisions.length === 0 ? (
                    <p style={{ margin: 0, padding: "var(--sb-space-3)", color: "var(--sb-text-soft)", fontSize: "0.6875rem" }}>
                      Nenhuma decisão registrada. Uma decisão nasce em <Link href="/acoes">Ações</Link>, e é ela que
                      permite medir o depois contra o antes.
                    </p>
                  ) : (
                    decisions.slice(0, 3).map((linha) => (
                      <div key={linha.id} className="sb-feed-row">
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <b style={{ display: "block" }}>{linha.decision}</b>
                          <small style={{ display: "block", marginTop: 3, fontSize: "0.5625rem", color: "var(--sb-text-soft)" }}>
                            {formatDateTime(linha.created_at)}
                          </small>
                        </span>
                      </div>
                    ))
                  )}
                </Panel>
              </div>

            </>
          )}
        </>
      )}

      {tab === "vendas" && (
        <>
          <div className="sb-section-label" style={{ marginTop: 0 }}>
            <span>Vendas do SKU</span>
            <span className="sb-section-note">últimos {LOOKBACK_DAYS} dias, somadas entre as contas no banco</span>
          </div>

          {/*
            D-227. A fonte é o recálculo por conta e por dia (`daily_sku_metrics`,
            refeito a cada reconciliação horária de pedidos nos dias que
            mudaram) — não é leitura ao vivo de `orders`. Somar entre contas é
            seguro porque pack e pedido pertencem a UMA conta (D-017/D-050), e
            somar entre dias também: medido em 03/09/2026, 172.624 packs, ZERO
            em mais de um dia.
          */}

          {salesResult.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar as vendas: {salesResult.error.message}
            </p>
          )}

          {salesResult.error === null && salesTotal === null && (
            <p className="sb-empty">Sem dado de vendas para este SKU.</p>
          )}

          {salesResult.error === null && salesTotal !== null && (
            <>
              <div style={{ marginBottom: "var(--sb-space-3)" }}>
                <KpiStrip ancora cells={salesCells(salesTotal)} />
              </div>

              {salesTotal.units_sold === 0 && (
                <p style={{ color: "var(--sb-text-soft)", fontSize: "0.6875rem", marginBottom: "var(--sb-space-3)" }}>
                  Nenhuma venda válida contabilizada para este SKU no período. É o que o recálculo registrou: um
                  pedido ainda não reconciliado, ou vendido por anúncio sem vínculo com este SKU, não entra aqui.
                </p>
              )}

              {salesByAccount.length > 0 && (
                  <Panel title="Por conta" subtitle="Ticket médio e preço médio são razões sobre as somas de cada conta — nunca média das médias diárias.">
                  <div style={{ overflowX: "auto" }}>
                    <table className="sb-table" style={{ minWidth: "44rem" }}>
                      <thead>
                        <tr>
                          <th>Conta</th>
                          <th className="sb-num">Unidades</th>
                          <th className="sb-num">Receita bruta</th>
                          <th className="sb-num">Pedidos</th>
                          <th className="sb-num">Compras</th>
                          <th className="sb-num">Ticket médio</th>
                          <th className="sb-num">Preço médio</th>
                        </tr>
                      </thead>
                      <tbody>
                        {salesByAccount.map((linha) => (
                          <tr key={linha.ml_account_id ?? linha.account_label ?? "conta"}>
                            {/* `account_label` vem de LEFT JOIN em ml_accounts: uma conta
                                que a RLS não mostre (ou que tenha sido removida) deixa a
                                venda visível e o rótulo nulo — a venda aconteceu. */}
                            <td>{linha.account_label ?? "Conta não identificada"}</td>
                            <td className="sb-num">{formatCount(linha.units_sold)}</td>
                            <td className="sb-num">{formatCurrency(linha.gross_revenue)}</td>
                            <td className="sb-num">{formatCount(linha.orders_count)}</td>
                            <td className="sb-num">{formatCount(linha.purchases_count)}</td>
                            <td className="sb-num">{formatCurrency(linha.average_ticket)}</td>
                            <td className="sb-num">{formatCurrency(linha.average_selling_price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              )}

              {salesByDay.length > 0 && (
                  <Panel title="Por dia" subtitle="Dias sem venda registrada não aparecem — o recálculo não fabrica zero (mesmo contrato de /vendas). Duas contas no mesmo dia viram uma linha só.">
                  <div style={{ overflowX: "auto" }}>
                    <table className="sb-table" style={{ minWidth: "32rem" }}>
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
                        {salesByDay.map((linha) => (
                          <tr key={linha.metric_date ?? "dia"}>
                            {/* `metric_date` é DATA DE NEGÓCIO (YYYY-MM-DD): formatar por
                                string, nunca por `new Date` (deslocaria o dia civil). */}
                            <td style={{ whiteSpace: "nowrap" }}>
                              {linha.metric_date === null ? "—" : formatBusinessDate(linha.metric_date)}
                            </td>
                            <td className="sb-num">{formatCount(linha.units_sold)}</td>
                            <td className="sb-num">{formatCurrency(linha.gross_revenue)}</td>
                            <td className="sb-num">{formatCount(linha.orders_count)}</td>
                            <td className="sb-num">{formatCount(linha.purchases_count)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              )}

              {salesTotal.last_computed_at !== null && (
                <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
                  Recálculo mais recente entre as linhas mostradas: {formatDateTime(salesTotal.last_computed_at)}.
                </p>
              )}
            </>
          )}
        </>
      )}

      {tab === "estoque" && (
        <>
          {dashboardResult.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar o resumo: {dashboardResult.error.message}
            </p>
          )}

          {dashboard !== null && (
            <>
              <div className="sb-section-label" style={{ marginTop: 0 }}>
                <span>Saldo por local</span>
                <span className="sb-section-note">
                  os quatro estados do ledger — nenhum deles é a soma dos outros
                </span>
              </div>

              <StockBoxes dashboard={dashboard} />

              <Panel
                title="Simulador de cobertura"
                subtitle="Premissas pré-preenchidas com o saldo local e a venda média medida; mudar qualquer uma delas muda só a simulação, nunca o dado."
                aside={
                  <Link href={`/estoque/${skuId}/ajuste`} style={{ color: "var(--sb-secondary)", textDecoration: "none" }}>
                    Ajustar estoque →
                  </Link>
                }
              >
                <div style={{ padding: "var(--sb-space-2) var(--sb-space-3) var(--sb-space-3)" }}>
                  <SimulatorPanel
                    asOf={dateTo}
                    initialStockQuantity={coverage?.local_quantity ?? 0}
                    initialAvgDailySales={coverage?.avg_daily_sales ?? 0}
                  />

                  <p style={{ margin: "var(--sb-space-2) 0 0", fontSize: "0.625rem", color: "var(--sb-text-soft)" }}>
                    Todo ajuste manual de estoque exige motivo e fica no ledger — ele é movimento auditável, não
                    correção silenciosa.
                  </p>
                </div>
              </Panel>
            </>
          )}
        </>
      )}

      {tab === "anuncios" && (
        <Panel title="Anúncios vinculados">
          <div className="sb-panel-body">

          {listingsResult.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar os anúncios: {listingsResult.error.message}
            </p>
          )}

          {listingsResult.error === null && listings.length === 0 && (
            <p style={{ color: "var(--sb-text-soft)" }}>Nenhum anúncio vinculado a este SKU.</p>
          )}

          {listingsResult.error === null && listings.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table" style={{ minWidth: "36rem" }}>
                <thead>
                  <tr>
                    <th>Anúncio</th>
                    <th>Conta</th>
                    <th>Estado</th>
                    <th>Preço</th>
                  </tr>
                </thead>

                <tbody>
                  {listings.map((listing) => (
                    <tr key={listing.id}>
                      <td>
                        {listing.title}
                        <div
                          style={{
                            fontFamily: "ui-monospace, monospace",
                            color: "var(--sb-text-soft)",
                            fontSize: "0.75rem",
                          }}
                        >
                          <Link href={`/anuncios/${listing.item_id}`}>{listing.item_id}</Link>
                        </div>
                      </td>
                      <td>{listing.ml_accounts.label}</td>
                      <td>
                        <StatusPill code={listing.status} label={listingStatusLabel(listing.status)} />
                      </td>
                      <td className="sb-num">{formatCurrency(listing.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </div>
        </Panel>
      )}

      {tab === "full" && (
        <Panel title="Full por conta">
          <div className="sb-panel-body">

          <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
            Saldo no Full de cada conta, somado por bucket de variação — o grão que D-173 mediu como certo. O
            estoque LOCAL aparece em coluna separada de propósito: são quatro estados com autoridades
            diferentes, e somá-los daria um número que não existe.
          </p>

          {fullResult.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar o Full: {fullResult.error.message}
            </p>
          )}

          {fullResult.error === null && full.length === 0 && (
            <p style={{ color: "var(--sb-text-soft)" }}>
              Nenhuma conta com snapshot recente de Full para este SKU. Ausência de snapshot não é o mesmo que
              saldo zero — é a falta do dado.
            </p>
          )}

          {fullResult.error === null && full.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table" style={{ minWidth: "40rem" }}>
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
                  {full.map((linha) => (
                    <tr key={linha.ml_account_id}>
                      <td>{linha.account_label}</td>
                      <td className="sb-num">{formatCount(linha.full_quantity)}</td>
                      <td className="sb-num">{formatCount(linha.buckets)}</td>
                      <td className="sb-num">{formatCount(linha.local_quantity)}</td>
                      <td className="sb-num">{formatCount(linha.units_sold)}</td>
                      <td style={{ color: linha.situation === "ruptura" ? "var(--sb-danger)" : undefined }}>
                        <span title={fullSituationCriterion(linha.situation)}>
                          {fullSituationLabel(linha.situation)}
                        </span>
                      </td>
                      {/* Sem checagem de nulo, e a razão foi conferida no SQL, não no
                          compilador (D-192/D-206): a consulta é DIRIGIDA pelo snapshot —
                          `vendas` e `saldo_local` é que entram por left join —, então
                          toda linha devolvida tem `captured_at`. O nulo é inalcançável. */}
                      <td style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
                        {formatDateTime(linha.captured_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </div>
        </Panel>
      )}

      {tab === "precos" && (
        <Panel title="Mudanças de preço observadas">
          <div className="sb-panel-body">

          {/*
            D-226. A palavra "observadas" não é enfeite: `listing.price.changed`
            é um DIFF entre dois snapshots de 6 em 6 horas, então uma mudança que
            sobe e volta dentro da mesma janela não existe aqui, e a primeira
            aparição de um anúncio não gera evento (não há "antes").
          */}
          <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
            Preço de cada anúncio deste SKU, comparado a cada sincronização (de 6 em 6 horas), nos últimos{" "}
            {LOOKBACK_DAYS} dias. <strong>Não há análise de impacto</strong>: a série começa em 24/08/2026 e a
            mediana é de uma mudança por SKU — ligar preço a venda com isso seria inventar causa.
          </p>

          {pricesResult.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar as mudanças de preço: {pricesResult.error.message}
            </p>
          )}

          {pricesResult.error === null && prices.length === 0 && (
            <p style={{ color: "var(--sb-text-soft)" }}>
              Nenhuma mudança de preço observada neste período. Isso <strong>não</strong> quer dizer que o preço
              ficou parado: uma alteração feita e desfeita entre duas sincronizações não deixa registro.
            </p>
          )}

          {pricesResult.error === null && prices.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table" style={{ minWidth: "42rem" }}>
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Anúncio</th>
                    <th>Conta</th>
                    <th className="sb-num">De</th>
                    <th className="sb-num">Para</th>
                    <th className="sb-num">Δ</th>
                    <th className="sb-num">Δ %</th>
                  </tr>
                </thead>

                <tbody>
                  {prices.map((linha) => {
                    const subiu = linha.delta > 0;
                    const cor = subiu ? "var(--sb-secondary)" : "var(--sb-danger)";

                    return (
                      <tr key={linha.event_id}>
                        <td style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
                          {formatDateTime(linha.occurred_at)}
                        </td>
                        <td>
                          <Link href={`/anuncios/${linha.item_id}`}>{linha.item_id}</Link>
                          {/* Título vem de LEFT JOIN: o anúncio pode ter saído do
                              catálogo depois do evento, e o evento continua sendo
                              verdade. Mostrar o MLB sem título é mais honesto do que
                              esconder a linha (contrato de D-172). */}
                          {linha.title !== null && (
                            <div style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>{linha.title}</div>
                          )}
                        </td>
                        <td>{linha.account_label}</td>
                        <td className="sb-num">{formatCurrency(linha.price_before)}</td>
                        <td className="sb-num">{formatCurrency(linha.price_after)}</td>
                        <td className="sb-num" style={{ color: cor }}>
                          {subiu ? "+" : ""}
                          {formatCurrency(linha.delta)}
                        </td>
                        <td className="sb-num" style={{ color: cor }}>
                          {/* NULL quando o preço anterior era zero — a fração não
                              existe, e "0%" seria mentira. */}
                          {linha.delta_ratio === null ? "—" : `${subiu ? "+" : ""}${formatPercent(linha.delta_ratio)}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          </div>
        </Panel>
      )}

      {tab === "historico" && (
        <>
        <Panel title="Custo cadastrado">
          <div className="sb-panel-body">
          {/*
            Custo cadastrado + histórico (D-149). Duas honestidades: o
            registro começa em 30/08/2026 (não há como historiar o que a
            importação já sobrescreveu antes), e o custo de PEDIDO é outro
            número — vive em purchase_order_items.unit_cost e nunca escreve
            de volta aqui.
          */}

          <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
            Custo atual: <strong>{formatCurrency(sku.data.purchase_cost)}</strong> — sobrescrito a cada importação do
            UpSeller; desde 30/08/2026 toda mudança fica registrada abaixo. O custo usado num pedido de compra é
            editável no próprio pedido e nunca altera este cadastro.
          </p>

          {costHistoryResult.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar o histórico de custo: {costHistoryResult.error.message}
            </p>
          )}

          {costHistoryResult.error === null && costHistory.length === 0 && (
            <p style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem", marginBottom: "var(--sb-space-4)" }}>
              Nenhuma mudança registrada desde o início do rastreio (30/08/2026).
            </p>
          )}

          {costHistoryResult.error === null && costHistory.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table" style={{ minWidth: "32rem" }}>
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>De</th>
                    <th>Para</th>
                    <th>Origem</th>
                  </tr>
                </thead>
                <tbody>
                  {costHistory.map((entry) => (
                    <tr key={entry.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(entry.changed_at)}</td>
                      {/* `De` vazio = primeiro registro (o SKU nasceu com custo). */}
                      <td className="sb-num">{formatCurrency(entry.previous_cost)}</td>
                      <td className="sb-num">{formatCurrency(entry.new_cost)}</td>
                      <td style={{ color: "var(--sb-text-soft)" }}>
                        {entry.changed_by_role === "service_role"
                          ? "importação (worker)"
                          : entry.changed_by_role === "postgres"
                            ? "operação direta no banco"
                            : entry.changed_by_role}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          </div>
        </Panel>

        <div style={{ marginTop: "var(--sb-space-3)" }}>
          <Panel title="Linha do tempo">
            <div className="sb-panel-body">
          {/*
            Linha do tempo (D-153) — a ordem dos acontecimentos. Vocabulário
            ABERTO de propósito (contrato oposto ao da correlação): história
            não edita o passado. Diff só para formatos documentados
            (formatEventDiff devolve null para o resto — nunca leitura
            inventada).
          */}

          {timelineResult.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar a linha do tempo: {timelineResult.error.message}
            </p>
          )}

          {timelineResult.error === null && timeline.length === 0 && (
            <p style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem", marginBottom: "var(--sb-space-4)" }}>
              Nenhum evento registrado para este SKU — a linha do tempo nasce dos eventos de domínio (webhook e
              reconciliações) e só enxerga o que o sistema registrou.
            </p>
          )}

          {timelineResult.error === null && timeline.length > 0 && (
            <>
              {timeline.length >= TIMELINE_LIMIT && (
                <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
                  Mostrando os {TIMELINE_LIMIT} eventos mais recentes.
                </p>
              )}
              <div style={{ overflowX: "auto" }}>
                <table className="sb-table" style={{ minWidth: "48rem" }}>
                  <thead>
                    <tr>
                      <th>Quando</th>
                      <th>Evento</th>
                      <th>Mudança</th>
                      <th>Onde</th>
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
                        <td style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem" }}>
                          {entityLabel(entry.entity_type)}
                          {entry.entity_type !== "sku" && (
                            <span style={{ fontFamily: "ui-monospace, monospace" }}> {entry.entity_id}</span>
                          )}
                          {entry.account_label !== null && <> · {entry.account_label}</>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          </div>
          </Panel>
        </div>
        </>
      )}

      {tab === "diagnostico" && <DiagnosisPanel skuId={sku.data.id} />}

      {tab === "decisoes" && (
        <Panel title="Decisões registradas">
          <div className="sb-panel-body">

          {/*
            D-228. Memória de decisões (Fase 6, D-064/D-065): a decisão nasce de
            uma AÇÃO na Central e guarda o retrato do SKU no momento
            (get_sku_decision_snapshot); o job de medição refaz o retrato 7, 15
            e 30 dias depois. Comparação BRUTA lado a lado, nunca uma % de
            "resultado" — e "depois" não é "por causa".
          */}
          <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
            Cada decisão nasce de uma ação da <Link href="/acoes">Central de Ações</Link> e guarda um retrato do
            SKU no momento — venda de 7 dias, preço médio e estoque local. O job de medição refaz o mesmo retrato 7,
            15 e 30 dias depois. A comparação é <strong>lado a lado, bruta</strong>: nenhuma porcentagem de
            resultado é sintetizada, e &ldquo;depois&rdquo; não quer dizer &ldquo;por causa&rdquo;.
          </p>

          {decisionsResult.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar as decisões: {decisionsResult.error.message}
            </p>
          )}

          {decisionsResult.error === null && decisions.length === 0 && (
            <p style={{ color: "var(--sb-text-soft)" }}>
              Nenhuma decisão registrada para este SKU.{" "}
              {openActionsResult.error !== null && (
                <span role="alert" style={{ color: "var(--sb-danger)" }}>
                  Não foi possível contar as ações abertas: {openActionsResult.error.message}
                </span>
              )}
              {openActionsResult.error === null && openActions !== null && openActions > 0 && (
                <>
                  Há {formatCount(openActions)} ação(ões) aberta(s) dele na{" "}
                  <Link href="/acoes">Central de Ações</Link> — é lá que uma decisão é registrada e depois medida.
                </>
              )}
              {openActionsResult.error === null && openActions === 0 && (
                <>Também não há ação aberta para ele na Central de Ações.</>
              )}
            </p>
          )}

          {decisionsResult.error === null && decisions.length > 0 && (
            <div style={{ margin: "0 calc(-1 * var(--sb-space-3))" }}>
              {decisions.map((decision) => {
                // A visão normalizada da ação (`describeActionEvidence` é total
                // para qualquer `kind`, D-116) — a mesma que a Central usa.
                const acao = describeActionEvidence(decision.actions.kind, decision.actions.evidence);
                // Ordenar 3 medições e listar as janelas ausentes não é agregar.
                const medidas = [...decision.action_outcomes].sort((a, b) => a.window_days - b.window_days);
                const pendentes = OUTCOME_WINDOWS_DAYS.filter(
                  (dias) => !medidas.some((medida) => medida.window_days === dias),
                );

                return (
                  /*
                    Uma decisão é um item de FEED (título em negrito, uma linha
                    de contexto, o instante) seguido do retrato "antes × depois"
                    em tabela — em vez de cinco parágrafos iguais. A comparação
                    continua bruta e lado a lado (D-228).
                  */
                  <article key={decision.id} className="sb-panel-body" style={{ borderTop: "1px solid var(--sb-border)" }}>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", flexWrap: "wrap" }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <b style={{ display: "block", fontSize: "0.75rem" }}>{decision.decision}</b>
                        <small style={{ display: "block", marginTop: 3, fontSize: "0.625rem", color: "var(--sb-text-soft)" }}>
                          {acao.kindLabel}
                          {acao.direcaoLabel !== null && ` · ${acao.direcaoLabel}`}
                          {` · ${formatDateTime(decision.created_at)}`}
                        </small>
                      </span>
                      <StatusPill code={decision.actions.status} label={actionStatusLabel(decision.actions.status)} />
                    </div>

                    <p style={{ margin: "var(--sb-space-2) 0", fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
                      Recomendação da ação: {decision.actions.recommendation}
                    </p>

                    <table className="sb-table">
                      <thead>
                        <tr>
                          <th>Momento</th>
                          <th>Retrato</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td style={{ whiteSpace: "nowrap" }}>No momento da decisão</td>
                          <td style={{ whiteSpace: "normal" }}>{formatDecisionSnapshot(decision.baseline_snapshot)}</td>
                        </tr>
                        {medidas.map((medida) => (
                          <tr key={medida.window_days}>
                            <td style={{ whiteSpace: "nowrap" }}>
                              {outcomeWindowLabel(medida.window_days)}
                              <span style={{ display: "block", fontSize: "0.625rem", color: "var(--sb-text-soft)" }}>
                                {formatDateTime(medida.measured_at)}
                              </span>
                            </td>
                            <td style={{ whiteSpace: "normal" }}>{formatDecisionSnapshot(medida.outcome_snapshot)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {pendentes.length > 0 && (
                      <p style={{ margin: "var(--sb-space-2) 0 0", fontSize: "0.625rem", color: "var(--sb-text-soft)" }}>
                        Ainda sem medição: {pendentes.map(outcomeWindowLabel).join(", ")}.
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
          )}
          </div>
        </Panel>
      )}
      </ObjectHeader>
    </Shell>
  );
}
