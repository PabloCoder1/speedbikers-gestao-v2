import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Shell } from "../../../components/shell";
import { StatusPill } from "../../../components/status-pill";
import { formatCount, formatCurrency, formatDateTime } from "../../../lib/format";
import { listingStatusLabel } from "../../../lib/labels";
import { createClient } from "../../../lib/supabase/server";
import { DiagnosisPanel } from "./diagnosis-panel";
import { SimulatorPanel } from "./simulator-panel";

export const metadata = { title: "Dashboard de SKU — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * "Dashboard de SKU" (Fase 5B, docs/ROADMAP.md) — a metade de SKU do item de
 * checklist. Resumo de um SKU: estoque em cada estado (LOCAL/RESERVADO/
 * TRANSITO/Full) e venda somada, tudo vindo de `get_sku_dashboard` (soma em
 * SQL — docs/ARCHITECTURE.md secao 21). Listings vinculados são um select
 * direto à parte, sem agregação.
 *
 * Janela FIXA de 30 dias, mesma convenção de /cobertura.
 */

const LOOKBACK_DAYS = 30;

const statBox: React.CSSProperties = {
  border: "1px solid var(--sb-border)",
  borderRadius: "var(--sb-radius)",
  padding: "var(--sb-space-3)",
  minWidth: "9rem",
};

const statLabel: React.CSSProperties = {
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--sb-text-soft)",
};

const statValue: React.CSSProperties = {
  fontSize: "1.375rem",
  fontVariantNumeric: "tabular-nums",
};

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
};

const tdNumber: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

export default async function SkuDashboardPage({
  params,
}: {
  params: Promise<{ skuId: string }>;
}): Promise<ReactNode> {
  const { skuId } = await params;

  const supabase = await createClient();

  const sku = await supabase
    .from("skus")
    .select("id, sku, title, organization_id, purchase_cost")
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

  const [dashboardResult, listingsResult, coverageResult, costHistoryResult] = await Promise.all([
    supabase
      .rpc("get_sku_dashboard", {
        p_organization_id: sku.data.organization_id,
        p_sku_id: sku.data.id,
        p_date_from: dateFrom,
        p_date_to: dateTo,
      })
      .single(),
    supabase
      .from("listings")
      .select("id, item_id, title, status, price, ml_accounts(label)")
      .eq("sku_id", sku.data.id)
      .order("title"),
    // Mesma janela de 30 dias do resumo acima — venda média diária real,
    // só para pré-preencher a premissa do simulador (D-080); o usuário
    // pode ajustar livremente a partir daí.
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
    supabase
      .from("sku_cost_history")
      .select("id, previous_cost, new_cost, changed_by_role, changed_at")
      .eq("sku_id", sku.data.id)
      .order("changed_at", { ascending: false })
      .limit(20),
  ]);

  const dashboard = dashboardResult.data;
  const listings = listingsResult.data ?? [];
  const coverage = coverageResult.data;
  const costHistory = costHistoryResult.data ?? [];

  return (
    <Shell>
      <p style={{ margin: 0, fontSize: "0.875rem" }}>
        <Link href="/estoque">← Estoque</Link>
      </p>

      <h1 style={{ margin: "var(--sb-space-2) 0", fontSize: "1.375rem" }}>{sku.data.sku}</h1>

      {sku.data.title !== null && (
        <p style={{ margin: "0 0 var(--sb-space-4)", color: "var(--sb-text-soft)" }}>{sku.data.title}</p>
      )}

      {dashboardResult.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar o resumo: {dashboardResult.error.message}
        </p>
      )}

      {dashboard !== null && (
        <>
          <div style={{ display: "flex", gap: "var(--sb-space-3)", flexWrap: "wrap", marginBottom: "var(--sb-space-2)" }}>
            <div style={statBox}>
              <div style={statLabel}>Local</div>
              <div style={statValue}>{formatCount(dashboard.local_quantity)}</div>
            </div>
            <div style={statBox}>
              <div style={statLabel}>Reservado</div>
              <div style={statValue}>{formatCount(dashboard.reservado_quantity)}</div>
            </div>
            <div style={statBox}>
              <div style={statLabel}>Em trânsito</div>
              <div style={statValue}>{formatCount(dashboard.transito_quantity)}</div>
            </div>
            <div style={statBox}>
              <div style={statLabel}>Full</div>
              <div style={statValue}>{formatCount(dashboard.full_quantity)}</div>
            </div>
          </div>

          <div style={{ display: "flex", gap: "var(--sb-space-3)", flexWrap: "wrap", marginBottom: "var(--sb-space-4)" }}>
            <div style={statBox}>
              <div style={statLabel}>Vendido ({LOOKBACK_DAYS}d)</div>
              <div style={statValue}>{formatCount(dashboard.units_sold)}</div>
            </div>
            <div style={statBox}>
              <div style={statLabel}>Receita ({LOOKBACK_DAYS}d)</div>
              <div style={statValue}>{formatCurrency(dashboard.gross_revenue)}</div>
            </div>
          </div>

          <DiagnosisPanel skuId={sku.data.id} />

          <SimulatorPanel
            asOf={dateTo}
            initialStockQuantity={coverage?.local_quantity ?? 0}
            initialAvgDailySales={coverage?.avg_daily_sales ?? 0}
          />
        </>
      )}

      {/*
        Custo cadastrado + histórico (D-149). Duas honestidades: o registro
        começa em 30/08/2026 (não há como historiar o que a importação já
        sobrescreveu antes), e o custo de PEDIDO é outro número — vive em
        purchase_order_items.unit_cost e nunca escreve de volta aqui.
      */}
      <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.0625rem" }}>Custo cadastrado</h2>

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
        <div style={{ overflowX: "auto", marginBottom: "var(--sb-space-4)" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "32rem" }}>
            <thead>
              <tr>
                <th style={th}>Quando</th>
                <th style={th}>De</th>
                <th style={th}>Para</th>
                <th style={th}>Origem</th>
              </tr>
            </thead>
            <tbody>
              {costHistory.map((entry) => (
                <tr key={entry.id}>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{formatDateTime(entry.changed_at)}</td>
                  {/* `De` vazio = primeiro registro (o SKU nasceu com custo). */}
                  <td style={tdNumber}>{formatCurrency(entry.previous_cost)}</td>
                  <td style={tdNumber}>{formatCurrency(entry.new_cost)}</td>
                  <td style={{ ...td, color: "var(--sb-text-soft)" }}>
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

      <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.0625rem" }}>Anúncios vinculados</h2>

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
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "36rem" }}>
            <thead>
              <tr>
                <th style={th}>Anúncio</th>
                <th style={th}>Conta</th>
                <th style={th}>Estado</th>
                <th style={th}>Preço</th>
              </tr>
            </thead>

            <tbody>
              {listings.map((listing) => (
                <tr key={listing.id}>
                  <td style={td}>
                    {listing.title}
                    <div
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        color: "var(--sb-text-soft)",
                        fontSize: "0.75rem",
                      }}
                    >
                      {listing.item_id}
                    </div>
                  </td>
                  <td style={td}>{listing.ml_accounts.label}</td>
                  <td style={td}>
                    <StatusPill code={listing.status} label={listingStatusLabel(listing.status)} />
                  </td>
                  <td style={tdNumber}>{formatCurrency(listing.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
