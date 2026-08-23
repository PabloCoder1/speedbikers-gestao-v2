import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { StatusPill } from "../../components/status-pill";
import { formatCount, formatDateTime } from "../../lib/format";
import { purchaseOrderStatusLabel } from "../../lib/labels";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Pedidos de Compra — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de apps/web/app/importacoes/page.tsx.
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

export default async function ComprasPage(): Promise<ReactNode> {
  const supabase = await createClient();

  // Sem filtro por organização: a policy já restringe (purchase_orders_select_permitted).
  const { data, error } = await supabase
    .from("purchase_orders")
    .select("id, order_number, status, destination_warehouse_name, expected_at, created_at, suppliers(name)")
    .order("created_at", { ascending: false })
    .limit(100);

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
        <h1 style={{ margin: 0, fontSize: "1.375rem" }}>Pedidos de Compra</h1>

        <Link
          href="/compras/novo"
          style={{
            marginLeft: "auto",
            padding: "0.5rem 0.875rem",
            borderRadius: "var(--sb-radius)",
            background: "var(--sb-primary)",
            color: "var(--sb-white)",
            textDecoration: "none",
            fontSize: "0.875rem",
            fontWeight: 600,
          }}
        >
          Novo pedido
        </Link>
      </div>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && data.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>Nenhum pedido de compra criado ainda.</p>
      )}

      {data !== null && data.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "48rem" }}>
            <thead>
              <tr>
                <th style={th}>Nº</th>
                <th style={th}>Fornecedor</th>
                <th style={th}>Estado</th>
                <th style={th}>Destino</th>
                <th style={th}>Previsão</th>
                <th style={th}>Criado em</th>
              </tr>
            </thead>

            <tbody>
              {data.map((po) => (
                <tr key={po.id}>
                  <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                    <Link href={`/compras/${po.id}`}>#{po.order_number}</Link>
                  </td>
                  <td style={td}>{po.suppliers?.name ?? "—"}</td>
                  <td style={td}>
                    <StatusPill code={po.status} label={purchaseOrderStatusLabel(po.status)} />
                  </td>
                  <td style={td}>{po.destination_warehouse_name ?? "—"}</td>
                  <td style={td}>{po.expected_at === null ? "—" : formatDateTime(po.expected_at)}</td>
                  <td style={td}>{formatDateTime(po.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data !== null && data.length > 0 && (
        <p style={{ marginTop: "var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
          {formatCount(data.length)} pedido(s).
        </p>
      )}
    </Shell>
  );
}
