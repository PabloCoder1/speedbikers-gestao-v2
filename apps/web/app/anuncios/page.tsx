import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { StatusPill } from "../../components/status-pill";
import { formatCurrency, formatDateTime } from "../../lib/format";
import { listingStatusLabel } from "../../lib/labels";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Anúncios — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de apps/web/app/estoque/page.tsx.
export const dynamic = "force-dynamic";

/**
 * Primeira fatia de "Dashboards de SKU e de Anúncio" (Fase 5B,
 * docs/ROADMAP.md) — o estado atual de cada anúncio sincronizado (D-058).
 * Métricas de venda por anúncio (`daily_listing_metrics`, já existente
 * desde a Fase 5A) ficam para uma próxima etapa: esta tela já entrega valor
 * sozinha (é a primeira vez que `listings` aparece em alguma tela) sem
 * esperar o cruzamento pronto.
 */

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

export default async function AnunciosPage(): Promise<ReactNode> {
  const supabase = await createClient();

  // Sem filtro por conta: a policy já restringe (listings_select_own_account).
  const { data, error } = await supabase
    .from("listings")
    .select("id, item_id, title, status, price, available_quantity, synced_at, skus(sku), ml_accounts(label)")
    .order("title");

  return (
    <Shell>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sb-space-3)",
          marginBottom: "var(--sb-space-4)",
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.375rem" }}>Anúncios</h1>
      </div>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Estado atual de cada anúncio já vinculado a um SKU, sincronizado do Mercado Livre a cada 6h. Anúncio ainda
        sem vínculo não aparece aqui — a Central de Vinculações cuida disso.
      </p>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && data.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>Nenhum anúncio sincronizado ainda.</p>
      )}

      {error === null && data.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "48rem" }}>
            <thead>
              <tr>
                <th style={th}>Anúncio</th>
                <th style={th}>SKU</th>
                <th style={th}>Conta</th>
                <th style={th}>Estado</th>
                <th style={th}>Preço</th>
                <th style={th}>Disponível</th>
                <th style={th}>Sincronizado em</th>
              </tr>
            </thead>

            <tbody>
              {data.map((listing) => (
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
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>{listing.skus?.sku ?? "—"}</td>
                  <td style={td}>{listing.ml_accounts.label}</td>
                  <td style={td}>
                    <StatusPill code={listing.status} label={listingStatusLabel(listing.status)} />
                  </td>
                  <td style={tdNumber}>{formatCurrency(listing.price)}</td>
                  <td style={tdNumber}>{listing.available_quantity}</td>
                  <td style={td}>{formatDateTime(listing.synced_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
