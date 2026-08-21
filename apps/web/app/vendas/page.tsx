import type { FreshnessLevel } from "@sb/domain";
import {
  classifySyncFreshness,
  previousBusinessDateRange,
  shiftBusinessDate,
  toSalesMetricDate,
} from "@sb/domain";
import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { formatBusinessDate, formatCount, formatCurrency, formatDateTime } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Dashboard de Vendas — Speed Bikers Gestão" };

// A sessão vem de cookie e o RLS depende de quem está logado: pré-renderizar
// no build mostraria dado de outra pessoa. Ver apps/web/app/importacoes/page.tsx.
export const dynamic = "force-dynamic";

/**
 * Dashboard Geral de vendas — tela âncora da V3 (D-033).
 *
 * Segunda fatia da Fase 5A: filtro de período (`docs/PRODUCT_REQUIREMENTS.md`
 * — 7/15/30/60/90 dias e período personalizado) e comparação com o período
 * imediatamente anterior. Grão organização; Dashboard por Conta fica para a
 * próxima etapa (mesma `get_sales_summary`, passando `p_ml_account_id`).
 *
 * Filtro por link/formulário GET, sem componente cliente — mesmo padrão de
 * `apps/web/app/importacoes/[id]/page.tsx`. Toda soma acontece em SQL
 * (`get_sales_summary`), nunca em JavaScript (docs/ARCHITECTURE.md secao 21).
 *
 * "Comparação" aqui é o MESMO conjunto de seis métricas já aprovadas em
 * `docs/METRICS.md`, calculado duas vezes (período atual e anterior) — não é
 * uma métrica nova. `variacao_percentual_periodo`/`comparacao_periodo_anterior`
 * (docs/METRICS.md secao 5.4) têm definição pendente da Fase 5B; exibir um
 * "+12%" sintetizado agora seria um número sem `metric_definitions` por trás,
 * o que D-023 proíbe. Por isso a tela mostra os dois valores lado a lado e
 * deixa a leitura da variação para quem olha, não calcula a % sozinha.
 *
 * Os quatro backfills de 12 meses ainda não terminaram e nenhum rebuild
 * histórico rodou (docs/HANDOFF.md): é esperado que `get_sales_summary`
 * devolva `last_computed_at` nulo para janelas fora do que a reconciliação
 * já tocou — a tela distingue "nunca calculado" de "calculado e zero" em vez
 * de fingir um número que ainda não existe.
 */

const PRESET_DAYS = [7, 15, 30, 60, 90] as const;
const DEFAULT_DAYS = 30;

const FRESHNESS_TONE: Record<FreshnessLevel, { color: string; label: string }> = {
  ok: { color: "var(--sb-secondary)", label: "Atualizado" },
  atencao: { color: "var(--sb-accent-ink)", label: "Cálculo atrasando" },
  critico: { color: "var(--sb-danger)", label: "Cálculo desatualizado" },
  nunca_sincronizado: { color: "var(--sb-muted-ink)", label: "Nunca calculado" },
};

interface SalesSummary {
  units_sold: number;
  gross_revenue: number;
  orders_count: number;
  purchases_count: number;
  average_ticket: number | null;
  average_selling_price: number | null;
  last_computed_at: string | null;
}

interface MetricCardSpec {
  metricId: string;
  label: string;
  formula: string;
  format: (value: number | null) => string;
  current: number | null;
  previous: number | null;
}

function buildCards(current: SalesSummary, previous: SalesSummary | null): MetricCardSpec[] {
  return [
    {
      metricId: "receita_bruta",
      label: "Receita bruta",
      formula: "SUM(orders.total_amount) — pedidos pagos ou parcialmente reembolsados",
      format: formatCurrency,
      current: current.gross_revenue,
      previous: previous?.gross_revenue ?? null,
    },
    {
      metricId: "unidades_vendidas",
      label: "Unidades vendidas",
      formula: "SUM(order_items.quantity)",
      format: formatCount,
      current: current.units_sold,
      previous: previous?.units_sold ?? null,
    },
    {
      metricId: "pedidos",
      label: "Pedidos do Mercado Livre",
      formula: "COUNT(DISTINCT orders.id)",
      format: formatCount,
      current: current.orders_count,
      previous: previous?.orders_count ?? null,
    },
    {
      metricId: "pedidos_por_pack",
      label: "Compras (por pack)",
      formula: "COUNT(DISTINCT pack_id, com order_id como fallback)",
      format: formatCount,
      current: current.purchases_count,
      previous: previous?.purchases_count ?? null,
    },
    {
      metricId: "ticket_medio",
      label: "Ticket médio",
      formula: "receita_bruta / pedidos_por_pack",
      format: formatCurrency,
      current: current.average_ticket,
      previous: previous?.average_ticket ?? null,
    },
    {
      metricId: "preco_medio_praticado",
      label: "Preço médio praticado",
      formula: "receita_bruta / unidades_vendidas",
      format: formatCurrency,
      current: current.average_selling_price,
      previous: previous?.average_selling_price ?? null,
    },
  ];
}

function MetricCard({ card, showPrevious }: { card: MetricCardSpec; showPrevious: boolean }): ReactNode {
  return (
    <div
      title={card.formula}
      style={{
        padding: "var(--sb-space-3)",
        border: "1px solid var(--sb-border)",
        borderRadius: "var(--sb-radius)",
        display: "grid",
        gap: "0.25rem",
      }}
    >
      <span style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>{card.label}</span>
      <span style={{ fontSize: "1.5rem", fontWeight: 700 }}>{card.format(card.current)}</span>

      {showPrevious && (
        <span style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
          período anterior: {card.previous === null ? "sem dado" : card.format(card.previous)}
        </span>
      )}

      <span
        style={{
          fontSize: "0.6875rem",
          color: "var(--sb-muted-ink)",
          fontFamily: "ui-monospace, monospace",
        }}
      >
        {card.metricId}
      </span>
    </div>
  );
}

interface DateRange {
  from: string;
  to: string;
}

/**
 * Resolve a janela pedida pela URL. `from`/`to` explícitos vencem um `days`
 * concorrente; formato ruim ou intervalo invertido caem para o padrão em vez
 * de derrubar a página com 500 — mesmo espírito de `formatBusinessDate`.
 */
function resolveRange(
  query: Record<string, string | string[] | undefined>,
  today: string,
): { range: DateRange; days: number | null; invalidCustom: boolean } {
  const rawFrom = typeof query.from === "string" ? query.from : null;
  const rawTo = typeof query.to === "string" ? query.to : null;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

  if (rawFrom !== null && rawTo !== null) {
    if (dateRegex.test(rawFrom) && dateRegex.test(rawTo) && rawFrom <= rawTo) {
      return { range: { from: rawFrom, to: rawTo }, days: null, invalidCustom: false };
    }

    return {
      range: { from: shiftBusinessDate(today, -(DEFAULT_DAYS - 1)), to: today },
      days: DEFAULT_DAYS,
      invalidCustom: true,
    };
  }

  const rawDays = typeof query.days === "string" ? Number(query.days) : DEFAULT_DAYS;
  const days = (PRESET_DAYS as readonly number[]).includes(rawDays) ? rawDays : DEFAULT_DAYS;

  return { range: { from: shiftBusinessDate(today, -(days - 1)), to: today }, days, invalidCustom: false };
}

function periodHref(days: number): string {
  return days === DEFAULT_DAYS ? "/vendas" : `/vendas?days=${String(days)}`;
}

export default async function VendasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();
  const now = new Date();
  const today = toSalesMetricDate(now);

  const { range, days, invalidCustom } = resolveRange(query, today);
  const previousRange = previousBusinessDateRange(range.from, range.to);
  const isCustom = days === null;

  const [currentResult, previousResult] = await Promise.all([
    supabase
      .rpc("get_sales_summary", { p_date_from: range.from, p_date_to: range.to })
      .single(),
    supabase
      .rpc("get_sales_summary", { p_date_from: previousRange.from, p_date_to: previousRange.to })
      .single(),
  ]);

  const summary: SalesSummary | null = currentResult.data ?? null;
  const previousSummary: SalesSummary | null = previousResult.data ?? null;
  const error = currentResult.error;

  const lastComputedAt = summary?.last_computed_at ?? null;
  const freshness = classifySyncFreshness(lastComputedAt === null ? null : new Date(lastComputedAt), now);
  const freshnessTone = FRESHNESS_TONE[freshness];

  // "Nunca calculado" é diferente de "calculado e deu zero" — a primeira não
  // deve fingir R$ 0,00 real. Ver o comentário do módulo.
  const neverComputed = summary !== null && lastComputedAt === null;
  const previousHasData = previousSummary !== null && previousSummary.last_computed_at !== null;

  return (
    <Shell>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "var(--sb-space-2)",
          marginBottom: "var(--sb-space-1)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.375rem" }}>Dashboard de Vendas</h1>

        {summary !== null && (
          <span style={{ fontSize: "0.8125rem", fontWeight: 700, color: freshnessTone.color }}>
            {freshnessTone.label}
            {lastComputedAt !== null && ` · calculado até ${formatDateTime(lastComputedAt)}`}
          </span>
        )}
      </div>

      <p style={{ margin: "0 0 var(--sb-space-3)", color: "var(--sb-text-soft)", fontSize: "0.9375rem" }}>
        Todas as contas conectadas, {formatBusinessDate(range.from)} até {formatBusinessDate(range.to)} —
        comparado com {formatBusinessDate(previousRange.from)} até {formatBusinessDate(previousRange.to)}.
      </p>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "var(--sb-space-2)",
          marginBottom: "var(--sb-space-4)",
        }}
      >
        {PRESET_DAYS.map((preset) => (
          <Link
            key={preset}
            href={periodHref(preset)}
            style={{
              padding: "0.25rem 0.75rem",
              borderRadius: "999px",
              border: "1px solid var(--sb-border)",
              fontSize: "0.8125rem",
              textDecoration: "none",
              background: !isCustom && days === preset ? "var(--sb-primary)" : "transparent",
              color: !isCustom && days === preset ? "var(--sb-white)" : "var(--sb-text-soft)",
            }}
          >
            {preset} dias
          </Link>
        ))}

        <form
          method="get"
          style={{ display: "flex", alignItems: "center", gap: "0.375rem", fontSize: "0.8125rem" }}
        >
          <input
            type="date"
            name="from"
            defaultValue={isCustom ? range.from : undefined}
            aria-label="Data inicial"
            style={{
              padding: "0.25rem 0.5rem",
              borderRadius: "var(--sb-radius)",
              border: "1px solid var(--sb-border)",
              fontSize: "0.8125rem",
            }}
          />
          <span style={{ color: "var(--sb-text-soft)" }}>até</span>
          <input
            type="date"
            name="to"
            defaultValue={isCustom ? range.to : undefined}
            aria-label="Data final"
            style={{
              padding: "0.25rem 0.5rem",
              borderRadius: "var(--sb-radius)",
              border: "1px solid var(--sb-border)",
              fontSize: "0.8125rem",
            }}
          />
          <button
            type="submit"
            style={{
              padding: "0.25rem 0.75rem",
              borderRadius: "999px",
              border: "1px solid var(--sb-border)",
              background: isCustom ? "var(--sb-primary)" : "transparent",
              color: isCustom ? "var(--sb-white)" : "var(--sb-text-soft)",
              fontSize: "0.8125rem",
              cursor: "pointer",
            }}
          >
            Personalizado
          </button>
        </form>
      </div>

      {invalidCustom && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Período personalizado inválido — mostrando os últimos {DEFAULT_DAYS} dias.
        </p>
      )}

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar as métricas: {error.message}
        </p>
      )}

      {error === null && neverComputed && (
        <p style={{ color: "var(--sb-text-soft)" }}>
          Nenhuma métrica calculada para este período ainda. As quatro contas conectadas ainda estão
          trazendo o histórico (backfill) — o recálculo só materializa dias tocados pela reconciliação.
        </p>
      )}

      {error === null && summary !== null && !neverComputed && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))",
            gap: "var(--sb-space-3)",
          }}
        >
          {buildCards(summary, previousSummary).map((card) => (
            <MetricCard key={card.metricId} card={card} showPrevious={previousHasData} />
          ))}
        </div>
      )}
    </Shell>
  );
}
