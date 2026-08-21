import type { FreshnessLevel } from "@sb/domain";
import { classifySyncFreshness, shiftBusinessDate, toSalesMetricDate } from "@sb/domain";
import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { formatBusinessDate, formatCount, formatCurrency, formatDateTime } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Dashboard de Vendas — Speed Bikers Gestão" };

// A sessão vem de cookie e o RLS depende de quem está logado: pré-renderizar
// no build mostraria dado de outra pessoa. Ver apps/web/app/importacoes/page.tsx.
export const dynamic = "force-dynamic";

/**
 * Dashboard Geral de vendas — tela âncora da V3 (D-033), primeira fatia da
 * Fase 5A depois de fatos/rollups/recálculo incremental (docs/HANDOFF.md).
 *
 * Deliberadamente pequena: janela fixa dos últimos 30 dias, grão
 * organização, sem seletor de período nem comparação — ambos ficam para a
 * próxima etapa. O Dashboard por Conta também fica para depois.
 *
 * Os quatro backfills de 12 meses ainda não terminaram e nenhum rebuild
 * histórico rodou (docs/HANDOFF.md): é esperado que `get_sales_summary`
 * devolva `last_computed_at` nulo ou uma janela pequena agora — a tela
 * distingue "nunca calculado" de "calculado e zero" em vez de fingir um
 * número que ainda não existe.
 *
 * Toda soma acontece em SQL (`get_sales_summary`), nunca em JavaScript
 * (docs/ARCHITECTURE.md secao 21). D-023: todo número carrega o ID da sua
 * definição — via `title` (tooltip nativo) com fórmula e fonte.
 */

const WINDOW_DAYS = 30;

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
  value: string;
}

function buildCards(summary: SalesSummary): MetricCardSpec[] {
  return [
    {
      metricId: "receita_bruta",
      label: "Receita bruta",
      formula: "SUM(orders.total_amount) — pedidos pagos ou parcialmente reembolsados",
      value: formatCurrency(summary.gross_revenue),
    },
    {
      metricId: "unidades_vendidas",
      label: "Unidades vendidas",
      formula: "SUM(order_items.quantity)",
      value: formatCount(summary.units_sold),
    },
    {
      metricId: "pedidos",
      label: "Pedidos do Mercado Livre",
      formula: "COUNT(DISTINCT orders.id)",
      value: formatCount(summary.orders_count),
    },
    {
      metricId: "pedidos_por_pack",
      label: "Compras (por pack)",
      formula: "COUNT(DISTINCT pack_id, com order_id como fallback)",
      value: formatCount(summary.purchases_count),
    },
    {
      metricId: "ticket_medio",
      label: "Ticket médio",
      formula: "receita_bruta / pedidos_por_pack",
      value: formatCurrency(summary.average_ticket),
    },
    {
      metricId: "preco_medio_praticado",
      label: "Preço médio praticado",
      formula: "receita_bruta / unidades_vendidas",
      value: formatCurrency(summary.average_selling_price),
    },
  ];
}

function MetricCard({ card }: { card: MetricCardSpec }): ReactNode {
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
      <span style={{ fontSize: "1.5rem", fontWeight: 700 }}>{card.value}</span>
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

export default async function VendasPage(): Promise<ReactNode> {
  const supabase = await createClient();
  const now = new Date();

  const dateTo = toSalesMetricDate(now);
  const dateFrom = shiftBusinessDate(dateTo, -(WINDOW_DAYS - 1));

  const { data, error } = await supabase
    .rpc("get_sales_summary", { p_date_from: dateFrom, p_date_to: dateTo })
    .single();

  const summary: SalesSummary | null = data ?? null;
  const lastComputedAt = summary?.last_computed_at ?? null;
  const freshness = classifySyncFreshness(lastComputedAt === null ? null : new Date(lastComputedAt), now);
  const freshnessTone = FRESHNESS_TONE[freshness];

  // "Nunca calculado" é diferente de "calculado e deu zero" — a primeira não
  // deve fingir R$ 0,00 real. Ver o comentário do módulo.
  const neverComputed = summary !== null && lastComputedAt === null;

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

      <p style={{ margin: "0 0 var(--sb-space-4)", color: "var(--sb-text-soft)", fontSize: "0.9375rem" }}>
        Últimos {WINDOW_DAYS} dias, todas as contas conectadas ({formatBusinessDate(dateFrom)} até{" "}
        {formatBusinessDate(dateTo)}). Filtro de período e comparação chegam na próxima etapa.
      </p>

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
          {buildCards(summary).map((card) => (
            <MetricCard key={card.metricId} card={card} />
          ))}
        </div>
      )}
    </Shell>
  );
}
