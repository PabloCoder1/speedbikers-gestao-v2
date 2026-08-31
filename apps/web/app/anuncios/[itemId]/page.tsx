import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Shell } from "../../../components/shell";
import { entityLabel, formatEventDiff } from "../../../lib/event-format";
import { formatCount, formatCurrency, formatDateTime, formatPercent } from "../../../lib/format";
import { eventTypeLabel, listingStatusLabel } from "../../../lib/labels";
import { createClient } from "../../../lib/supabase/server";

export const metadata = { title: "Dashboard do Anúncio — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Dashboard 360º do Anúncio (D-168, trilha 5E) — o destino individual que
 * não existia: cada anúncio deixa de ser uma linha de lista e vira uma
 * página com estado, desempenho, Full e a própria linha do tempo.
 *
 * Primeira versão em SEÇÕES verticais, o mesmo formato do Dashboard de SKU
 * — as abas do Figma são a evolução registrada (igual ao item P1 do SKU),
 * não pré-requisito. Tudo somado em SQL (`get_listing_dashboard_summary`,
 * poucos ms por índice de grão); consultas independentes em PARALELO
 * (§21 — o risco "N+1 por aba" morre aqui).
 *
 * A linha do tempo mostra os eventos DESTE anúncio (`entity_type='listing'`)
 * — é um recorte da timeline do SKU (D-153), não uma duplicata: o SKU
 * agrega três caminhos; aqui só o que aconteceu NESTE item, sem linguagem
 * causal.
 *
 * Fora desta versão, por registro: score de "saúde", Ads, escrita/relist
 * inline e causalidade por IA.
 */

const LOOKBACK_DAYS = 30;
const TIMELINE_LIMIT = 50;

interface TimelineEventRow {
  id: string;
  event_type: string;
  severity: string;
  occurred_at: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  entity_type: string;
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--sb-text-soft)",
  whiteSpace: "nowrap",
};

const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
  verticalAlign: "top",
};

const cardStyle: React.CSSProperties = {
  padding: "var(--sb-space-3)",
  border: "1px solid var(--sb-border)",
  borderRadius: "var(--sb-radius)",
  display: "grid",
  gap: "0.25rem",
};

/**
 * Dois campos separados, no mesmo padrão de `/vendas` (D-157): `ressalva` é
 * prosa para quem lê a tela, `metricId` é o id canônico do catálogo
 * (`metric_definitions`) — a exigência de D-023. Misturar os dois numa
 * string só faria o id parecer explicação, e explicação nenhuma substitui a
 * definição.
 */
function SummaryCard({
  label,
  value,
  ressalva,
  metricId,
}: {
  label: string;
  value: string;
  ressalva?: string;
  metricId?: string;
}): ReactNode {
  return (
    <div style={cardStyle}>
      <span style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>{label}</span>
      <span style={{ fontSize: "1.5rem", fontWeight: 700 }}>{value}</span>
      {ressalva !== undefined && (
        <span style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>{ressalva}</span>
      )}
      {metricId !== undefined && (
        <span
          style={{ fontSize: "0.6875rem", color: "var(--sb-muted-ink)", fontFamily: "ui-monospace, monospace" }}
        >
          {metricId}
        </span>
      )}
    </div>
  );
}

export default async function AnuncioPage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}): Promise<ReactNode> {
  const { itemId } = await params;
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

  const row = listing.data as unknown as {
    id: string;
    organization_id: string;
    ml_account_id: string;
    item_id: string;
    sku_id: string | null;
    title: string;
    status: string;
    price: number;
    currency_id: string;
    available_quantity: number;
    synced_at: string;
    ml_accounts: { label: string } | null;
    skus: { sku: string; title: string | null } | null;
  };

  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - (LOOKBACK_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);

  const [summaryResult, fullResult, timelineResult, actionsResult] = await Promise.all([
    supabase
      .rpc("get_listing_dashboard_summary", {
        p_organization_id: row.organization_id,
        p_ml_account_id: row.ml_account_id,
        p_item_id: row.item_id,
        p_date_from: dateFrom,
        p_date_to: dateTo,
      })
      .single(),
    // Full é espelho por SKU+conta: sem vínculo de SKU, não há como
    // rastrear — e a tela DIZ isso em vez de mostrar zero.
    row.sku_id === null
      ? Promise.resolve({ data: null, error: null })
      : supabase
          .from("fulfillment_stock_snapshots")
          .select("quantity, captured_at")
          .eq("ml_account_id", row.ml_account_id)
          .eq("sku_id", row.sku_id)
          .order("captured_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
    supabase
      .from("domain_events")
      .select("id, event_type, severity, occurred_at, before, after, entity_type")
      .eq("ml_account_id", row.ml_account_id)
      .eq("entity_type", "listing")
      .eq("entity_id", row.item_id)
      .order("occurred_at", { ascending: false })
      .limit(TIMELINE_LIMIT),
    supabase
      .from("actions")
      .select("id, kind, status, recommendation, created_at")
      .eq("mlb_id", row.item_id)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const summary = summaryResult.data;
  const full = fullResult.data;
  const timeline = (timelineResult.data ?? []) as unknown as TimelineEventRow[];
  const actions = actionsResult.data ?? [];

  // Falha em qualquer consulta secundária aparece como ERRO, nunca como
  // "sem dado" (D-067).
  const secondaryError = summaryResult.error ?? fullResult.error ?? timelineResult.error ?? actionsResult.error;

  return (
    <Shell>
      <p style={{ margin: 0, fontSize: "0.875rem" }}>
        <Link href="/anuncios">← Anúncios</Link>
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "var(--sb-space-2)", margin: "var(--sb-space-2) 0 0" }}>
        <h1 style={{ margin: 0, fontSize: "1.375rem" }}>{row.title}</h1>
        <span style={{ fontFamily: "ui-monospace, monospace", color: "var(--sb-text-soft)" }}>{row.item_id}</span>
      </div>

      <p style={{ margin: "var(--sb-space-1) 0 var(--sb-space-3)", color: "var(--sb-text-soft)", fontSize: "0.875rem" }}>
        {row.ml_accounts?.label ?? "Conta desconhecida"} · {listingStatusLabel(row.status)} ·{" "}
        {formatCurrency(row.price)} · {formatCount(row.available_quantity)} disponível ·{" "}
        {row.skus === null ? (
          <span style={{ color: "var(--sb-accent-ink)" }}>sem vínculo de SKU</span>
        ) : (
          <>
            SKU{" "}
            <Link href={`/skus/${row.sku_id ?? ""}`} style={{ fontFamily: "ui-monospace, monospace" }}>
              {row.skus.sku}
            </Link>
          </>
        )}{" "}
        · sincronizado {formatDateTime(row.synced_at)}
      </p>

      {secondaryError !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar parte do dashboard: {secondaryError.message}
        </p>
      )}

      <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.0625rem" }}>
        Vendas e tráfego — últimos {LOOKBACK_DAYS} dias
      </h2>

      {summary != null && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
            gap: "var(--sb-space-3)",
            marginBottom: "var(--sb-space-4)",
          }}
        >
          <SummaryCard label="Unidades vendidas" value={formatCount(summary.units_sold)} metricId="unidades_vendidas" />
          <SummaryCard label="Receita bruta" value={formatCurrency(summary.gross_revenue)} metricId="receita_bruta" />
          <SummaryCard label="Pedidos" value={formatCount(summary.orders_count)} metricId="pedidos" />
          <SummaryCard
            label="Visitas"
            value={formatCount(summary.visits)}
            ressalva={
              summary.days_observed === 0
                ? "nenhum dia com coleta de visitas no período"
                : `observadas em ${String(summary.days_observed)} de ${String(LOOKBACK_DAYS)} dias`
            }
            metricId="visitas"
          />
          <SummaryCard
            label="Conversão"
            value={summary.conversion === null ? "—" : formatPercent(summary.conversion)}
            ressalva={
              summary.conversion === null
                ? "sem visita observada — taxa indefinida, não 0%"
                : `pedidos ÷ visitas dos ${String(summary.days_observed)} dias observados`
            }
            metricId="taxa_conversao"
          />
        </div>
      )}

      <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.0625rem" }}>Full</h2>

      <p style={{ margin: "0 0 var(--sb-space-4)", fontSize: "0.875rem", color: "var(--sb-text-soft)" }}>
        {row.sku_id === null
          ? "Sem vínculo de SKU — o estoque Full é espelhado por SKU e conta, então este anúncio não é rastreável no Full até ser vinculado."
          : full === null
            ? "Nenhum snapshot de Full para este SKU nesta conta — o item não está no Full, ou nunca foi capturado."
            : `${formatCount(full.quantity)} unidade(s) no Full — snapshot de ${formatDateTime(full.captured_at)}.`}
      </p>

      {actions.length > 0 && (
        <>
          <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.0625rem" }}>Ações relacionadas</h2>
          <ul style={{ margin: "0 0 var(--sb-space-4)", paddingLeft: "1.25rem", fontSize: "0.875rem" }}>
            {actions.map((action) => (
              <li key={action.id} style={{ marginBottom: "0.25rem" }}>
                <Link href="/acoes">{action.kind}</Link>{" "}
                <span style={{ color: "var(--sb-text-soft)" }}>
                  ({action.status}, {formatDateTime(action.created_at)}) — {action.recommendation}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/*
        Linha do tempo DESTE anúncio — recorte por entidade, não duplicata da
        timeline do SKU (que agrega três caminhos). História, nunca causa.
      */}
      <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.0625rem" }}>Linha do tempo do anúncio</h2>

      {timeline.length === 0 && timelineResult.error === null && (
        <p style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem" }}>
          Nenhum evento registrado para este anúncio — a linha do tempo nasce dos eventos de domínio e só
          enxerga o que o sistema registrou.
        </p>
      )}

      {timeline.length > 0 && (
        <>
          {timeline.length >= TIMELINE_LIMIT && (
            <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
              Mostrando os {TIMELINE_LIMIT} eventos mais recentes.
            </p>
          )}
          <div style={{ overflowX: "auto", marginBottom: "var(--sb-space-4)" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "44rem" }}>
              <thead>
                <tr>
                  <th style={th}>Quando</th>
                  <th style={th}>Evento</th>
                  <th style={th}>Mudança</th>
                  <th style={th}>Onde</th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((entry) => (
                  <tr key={entry.id}>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>{formatDateTime(entry.occurred_at)}</td>
                    <td style={td}>
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
                    <td style={td}>{formatEventDiff(entry.event_type, entry.before, entry.after) ?? "—"}</td>
                    <td style={{ ...td, color: "var(--sb-text-soft)", fontSize: "0.8125rem" }}>
                      {entityLabel(entry.entity_type)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Shell>
  );
}
