import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { StatusPill } from "../../components/status-pill";
import { formatCount, formatCurrency, formatDateTime } from "../../lib/format";
import { listingStatusLabel } from "../../lib/labels";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Anúncios — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de apps/web/app/estoque/page.tsx.
export const dynamic = "force-dynamic";

/**
 * "Dashboards de SKU e de Anúncio" (Fase 5B, docs/ROADMAP.md) — a metade de
 * anúncio: estado atual (D-058) cruzado com venda somada dos últimos 30
 * dias (`get_listing_sales`, soma em SQL — docs/ARCHITECTURE.md secao 21) e,
 * desde D-032, visitas e conversão (`get_listing_traffic`, mesmo padrão).
 * Cruzamento feito em JS por CHAVE (ml_account_id + item_id/mlb_id), não é
 * agregação — a soma em si já veio pronta dos RPCs.
 */

const LOOKBACK_DAYS = 30;

/**
 * `conversion_rate` é anulável de verdade (`NULL` quando não há visita no
 * período, não `Infinity`) — mesma lacuna do gerador já documentada em
 * `/cobertura`/`/curva-abc`, aqui do lado do retorno de `get_listing_traffic`.
 */
interface TrafficRow {
  ml_account_id: string;
  item_id: string;
  visits: number;
  orders_count: number;
  conversion_rate: number | null;
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
};

const tdNumber: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

export default async function AnunciosPage(): Promise<ReactNode> {
  const supabase = await createClient();

  const membership = await supabase.from("organization_members").select("organization_id").maybeSingle();
  const organizationId = membership.data?.organization_id ?? null;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Anúncios</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - (LOOKBACK_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Sem filtro por conta: a policy já restringe (listings_select_own_account).
  const [listingsResult, salesResult, trafficResult] = await Promise.all([
    supabase
      .from("listings")
      .select(
        "id, item_id, sku_id, ml_account_id, title, status, price, available_quantity, synced_at, skus(sku), ml_accounts(label)",
      )
      .order("title"),
    supabase.rpc("get_listing_sales", {
      p_organization_id: organizationId,
      p_date_from: dateFrom,
      p_date_to: dateTo,
    }),
    supabase.rpc("get_listing_traffic", {
      p_organization_id: organizationId,
      p_date_from: dateFrom,
      p_date_to: dateTo,
    }),
  ]);

  const { data, error: listingsError } = listingsResult;
  // Falha em vendas/tráfego isolada ficava invisível antes (só o erro de
  // listingsResult era checado) — toda linha mostraria "—" em vendido/
  // receita/visitas/conversão, indistinguível de "sem venda no período"
  // (D-067).
  const error = listingsError ?? salesResult.error ?? trafficResult.error;
  // `error === null` não estreita `data` aqui (a checagem combina três
  // resultados) — `rows` é o array garantido, `data` original só sobrevive
  // pra nada mais ser lido dele abaixo.
  const rows = data ?? [];

  // Chave de junção: (ml_account_id, item_id) — mesmo par único de `listings`
  // e o mesmo espaço de valores de `daily_listing_metrics.mlb_id`. Junção por
  // chave em JS, não agregação — a soma já veio pronta dos RPCs.
  const salesByListing = new Map<string, { units_sold: number; gross_revenue: number }>();
  for (const row of salesResult.data ?? []) {
    salesByListing.set(`${row.ml_account_id}:${row.mlb_id}`, row);
  }

  const trafficByListing = new Map<string, TrafficRow>();
  for (const row of (trafficResult.data ?? []) as TrafficRow[]) {
    trafficByListing.set(`${row.ml_account_id}:${row.item_id}`, row);
  }

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
        Estado atual de cada anúncio já vinculado a um SKU, sincronizado do Mercado Livre a cada 6h, com venda dos
        últimos {LOOKBACK_DAYS} dias. Anúncio ainda sem vínculo não aparece aqui — a Central de Vinculações cuida
        disso.
      </p>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && rows.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>Nenhum anúncio sincronizado ainda.</p>
      )}

      {error === null && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "68rem" }}>
            <thead>
              <tr>
                <th style={th}>Anúncio</th>
                <th style={th}>SKU</th>
                <th style={th}>Conta</th>
                <th style={th}>Estado</th>
                <th style={th}>Preço</th>
                <th style={th}>Disponível</th>
                <th style={th}>Vendido ({LOOKBACK_DAYS}d)</th>
                <th style={th}>Receita ({LOOKBACK_DAYS}d)</th>
                <th style={th}>Visitas ({LOOKBACK_DAYS}d)</th>
                <th style={th}>Conversão</th>
                <th style={th}>Sincronizado em</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((listing) => {
                const sales = salesByListing.get(`${listing.ml_account_id}:${listing.item_id}`) ?? null;
                const traffic = trafficByListing.get(`${listing.ml_account_id}:${listing.item_id}`) ?? null;

                return (
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
                    <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                      {listing.sku_id !== null && listing.skus !== null ? (
                        <Link href={`/skus/${listing.sku_id}`}>{listing.skus.sku}</Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={td}>{listing.ml_accounts.label}</td>
                    <td style={td}>
                      <StatusPill code={listing.status} label={listingStatusLabel(listing.status)} />
                    </td>
                    <td style={tdNumber}>{formatCurrency(listing.price)}</td>
                    <td style={tdNumber}>{listing.available_quantity}</td>
                    <td style={tdNumber}>{sales === null ? "—" : formatCount(sales.units_sold)}</td>
                    <td style={tdNumber}>{sales === null ? "—" : formatCurrency(sales.gross_revenue)}</td>
                    <td style={tdNumber}>{traffic === null ? "—" : formatCount(traffic.visits)}</td>
                    <td style={tdNumber}>
                      {traffic?.conversion_rate == null ? "—" : `${String(traffic.conversion_rate)}%`}
                    </td>
                    <td style={td}>{formatDateTime(listing.synced_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
