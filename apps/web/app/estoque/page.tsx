import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { formatCount } from "../../lib/format";

import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Estoque — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de apps/web/app/compras/page.tsx.
export const dynamic = "force-dynamic";

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

interface SkuBalance {
  skuId: string;
  sku: string;
  title: string | null;
  local: number;
  reservado: number;
  transito: number;
}

export default async function EstoquePage(): Promise<ReactNode> {
  const supabase = await createClient();

  // Sem filtro por organização: a policy já restringe (inventory_balances_select_own_org).
  const { data, error } = await supabase
    .from("inventory_balances")
    .select("sku_id, location_kind, quantity, skus(sku, title)")
    .order("quantity", { ascending: false });

  const bySku = new Map<string, SkuBalance>();

  for (const row of data ?? []) {
    const existing = bySku.get(row.sku_id) ?? {
      skuId: row.sku_id,
      sku: row.skus.sku,
      title: row.skus.title,
      local: 0,
      reservado: 0,
      transito: 0,
    };

    if (row.location_kind === "LOCAL") existing.local = row.quantity;
    if (row.location_kind === "RESERVADO") existing.reservado = row.quantity;
    if (row.location_kind === "TRANSITO") existing.transito = row.quantity;

    bySku.set(row.sku_id, existing);
  }

  const balances = [...bySku.values()].sort((a, b) => a.sku.localeCompare(b.sku));

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
        <h1 style={{ margin: 0, fontSize: "1.375rem" }}>Estoque</h1>
      </div>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Saldo por SKU, recomputado do ledger (<code>stock_movements</code>). Local é o estoque físico; reservado vem
        da reconciliação contra o UpSeller; em trânsito, do ciclo de pedidos de compra.
      </p>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && balances.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>Nenhum SKU com movimento de estoque ainda.</p>
      )}

      {error === null && balances.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "40rem" }}>
            <thead>
              <tr>
                <th style={th}>SKU</th>
                <th style={th}>Local</th>
                <th style={th}>Reservado</th>
                <th style={th}>Em trânsito</th>
                <th style={th}></th>
              </tr>
            </thead>

            <tbody>
              {balances.map((balance) => (
                <tr key={balance.skuId}>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                    {balance.sku}
                    {balance.title !== null && (
                      <div style={{ fontFamily: "inherit", color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
                        {balance.title}
                      </div>
                    )}
                  </td>
                  <td style={tdNumber}>{formatCount(balance.local)}</td>
                  <td style={tdNumber}>{formatCount(balance.reservado)}</td>
                  <td style={tdNumber}>{formatCount(balance.transito)}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <Link href={`/estoque/${balance.skuId}/ajuste`}>Ajustar</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
