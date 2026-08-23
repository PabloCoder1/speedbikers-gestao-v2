import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Shell } from "../../../components/shell";
import { StatusPill } from "../../../components/status-pill";
import { formatCurrency, formatDateTime } from "../../../lib/format";
import { purchaseOrderEventLabel, purchaseOrderStatusLabel } from "../../../lib/labels";
import { createClient } from "../../../lib/supabase/server";
import { ActionsPanel } from "./actions-panel";

export const dynamic = "force-dynamic";

/**
 * Detalhe do pedido de compra: dados, itens (com nacional/importado puxado
 * do SKU) e histórico por evento (`purchase_order_events`, append-only) —
 * o item "histórico por evento" do checklist da Fase 4 é literalmente esta
 * seção.
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
  verticalAlign: "top",
};

function Stat({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div>
      <div style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>{label}</div>
      <div style={{ fontSize: "1.125rem", fontWeight: 600 }}>{value}</div>
    </div>
  );
}

export default async function PedidoDeCompraPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;

  const supabase = await createClient();

  const order = await supabase
    .from("purchase_orders")
    .select(
      "id, order_number, status, destination_warehouse_name, currency, notes, expected_at, approved_at, ordered_at, received_at, cancelled_at, cancel_reason, created_at, suppliers(name)",
    )
    .eq("id", id)
    .maybeSingle();

  // `null` aqui pode ser "não existe" ou "a policy escondeu" — a tela
  // responde igual nos dois casos, mesmo raciocínio já usado em
  // apps/web/app/importacoes/[id]/page.tsx.
  if (order.error !== null || order.data === null) {
    notFound();
  }

  const info = order.data;

  const [items, events] = await Promise.all([
    supabase
      .from("purchase_order_items")
      .select("id, position, sku_snapshot, title_snapshot, quantity_ordered, unit_cost, skus(is_imported)")
      .eq("purchase_order_id", id)
      .order("position"),
    supabase
      .from("purchase_order_events")
      .select("id, event_type, metadata, occurred_at")
      .eq("purchase_order_id", id)
      .order("occurred_at", { ascending: false }),
  ]);

  const totalValue = (items.data ?? []).reduce(
    (sum, item) => sum + item.quantity_ordered * (item.unit_cost ?? 0),
    0,
  );

  return (
    <Shell>
      <p style={{ margin: 0, fontSize: "0.875rem" }}>
        <Link href="/compras">← Pedidos de Compra</Link>
      </p>

      <h1 style={{ margin: "var(--sb-space-2) 0", fontSize: "1.375rem" }}>
        Pedido #{info.order_number}
        {info.suppliers?.name !== undefined && ` — ${info.suppliers.name}`}
      </h1>

      <div
        style={{
          display: "flex",
          gap: "var(--sb-space-4)",
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: "var(--sb-space-4)",
        }}
      >
        <StatusPill code={info.status} label={purchaseOrderStatusLabel(info.status)} />
        <Stat label="Destino" value={info.destination_warehouse_name ?? "—"} />
        <Stat label="Previsão" value={info.expected_at === null ? "—" : formatDateTime(info.expected_at)} />
        <Stat label="Itens" value={String(items.data?.length ?? 0)} />
        <Stat label="Valor estimado" value={formatCurrency(totalValue)} />

        <div style={{ display: "flex", gap: "var(--sb-space-2)", marginLeft: "auto" }}>
          {info.status === "DRAFT" && (
            <Link
              href={`/compras/${info.id}/editar`}
              style={{
                padding: "0.375rem 0.75rem",
                borderRadius: "var(--sb-radius)",
                border: "1px solid var(--sb-border)",
                fontSize: "0.8125rem",
                textDecoration: "none",
                color: "var(--sb-text)",
              }}
            >
              Editar
            </Link>
          )}

          <a
            href={`/compras/${info.id}/export/xlsx`}
            style={{
              padding: "0.375rem 0.75rem",
              borderRadius: "var(--sb-radius)",
              border: "1px solid var(--sb-border)",
              fontSize: "0.8125rem",
              textDecoration: "none",
              color: "var(--sb-text)",
            }}
          >
            Exportar Excel
          </a>
          <a
            href={`/compras/${info.id}/export/pdf`}
            style={{
              padding: "0.375rem 0.75rem",
              borderRadius: "var(--sb-radius)",
              border: "1px solid var(--sb-border)",
              fontSize: "0.8125rem",
              textDecoration: "none",
              color: "var(--sb-text)",
            }}
          >
            Exportar PDF
          </a>
        </div>
      </div>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
        A exportação usa um layout provisório — será ajustado quando o modelo de referência oficial chegar.
      </p>

      {info.notes !== null && (
        <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.875rem", color: "var(--sb-text-soft)" }}>
          {info.notes}
        </p>
      )}

      {info.status === "CANCELLED" && info.cancel_reason !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Cancelado: {info.cancel_reason}
        </p>
      )}

      <ActionsPanel purchaseOrderId={info.id} status={info.status} expectedAt={info.expected_at} />

      <h2 style={{ fontSize: "1rem", margin: "var(--sb-space-4) 0 var(--sb-space-2)" }}>Itens</h2>

      {items.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar os itens: {items.error.message}
        </p>
      )}

      {items.error === null && items.data.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "42rem" }}>
            <thead>
              <tr>
                <th style={th}>SKU</th>
                <th style={th}>Origem</th>
                <th style={th}>Quantidade</th>
                <th style={th}>Custo unitário</th>
                <th style={th}>Subtotal</th>
              </tr>
            </thead>

            <tbody>
              {items.data.map((item) => (
                <tr key={item.id}>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                    {item.sku_snapshot}
                    {item.title_snapshot !== null && (
                      <div style={{ fontFamily: "inherit", color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
                        {item.title_snapshot}
                      </div>
                    )}
                  </td>
                  <td style={td}>
                    {item.skus?.is_imported === true ? "Importado" : item.skus?.is_imported === false ? "Nacional" : "—"}
                  </td>
                  <td style={td}>{item.quantity_ordered}</td>
                  <td style={td}>{item.unit_cost === null ? "—" : formatCurrency(item.unit_cost)}</td>
                  <td style={td}>
                    {item.unit_cost === null ? "—" : formatCurrency(item.quantity_ordered * item.unit_cost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ fontSize: "1rem", margin: "var(--sb-space-4) 0 var(--sb-space-2)" }}>Histórico</h2>

      {events.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar o histórico: {events.error.message}
        </p>
      )}

      {events.error === null && events.data.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>Sem eventos ainda.</p>
      )}

      {events.error === null && events.data.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.375rem" }}>
          {events.data.map((event) => (
            <li
              key={event.id}
              style={{
                display: "flex",
                gap: "var(--sb-space-3)",
                alignItems: "baseline",
                padding: "0.375rem 0",
                borderBottom: "1px solid var(--sb-border)",
                fontSize: "0.875rem",
              }}
            >
              <strong style={{ minWidth: "10rem" }}>{purchaseOrderEventLabel(event.event_type)}</strong>
              <span style={{ color: "var(--sb-text-soft)" }}>{formatDateTime(event.occurred_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
