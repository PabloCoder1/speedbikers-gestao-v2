import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Shell } from "../../../components/shell";
import { StatusPill } from "../../../components/status-pill";
import { formatCurrency, formatDateTime } from "../../../lib/format";
import { purchaseOrderCostNote, summarizePurchaseOrderCost } from "../../../lib/purchase-order-cost";
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

function Stat({ label, value, note }: { label: string; value: string; note?: string }): ReactNode {
  return (
    <div>
      <div style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>{label}</div>
      <div style={{ fontSize: "1.125rem", fontWeight: 600 }}>{value}</div>
      {note !== undefined && (
        <div style={{ fontSize: "0.6875rem", color: "var(--sb-accent-ink)" }}>{note}</div>
      )}
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

  // As TRÊS leituras partem do mesmo `id` da URL (D-197). Havia um
  // `Promise.all` aqui, e ele escondia o problema: o par itens/eventos já ia
  // junto, mas o par inteiro esperava o cabeçalho do pedido — que nenhum dos
  // dois usa. Duas latências em fila onde uma resolve.
  //
  // O guarda `check:waterfalls` (D-195) não via isto: ele checava dependência
  // das leituras SOLTAS e tratava o `Promise.all` só como marco, sem nunca
  // perguntar se o próprio bloco dependia da leitura anterior. Foi esta tela
  // que mostrou o furo, e o guarda foi corrigido na mesma fatia.
  //
  // O guarda de 404 continua abaixo, e continua correto: a RLS restringe as
  // três leituras de forma independente, então disparar itens e eventos antes
  // de saber se o pedido existe não mostra nada a quem não podia ver. O preço
  // são duas consultas desperdiçadas no caminho 404, que é o caminho raro.
  const [order, items, events] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select(
        "id, order_number, status, destination_warehouse_name, currency, notes, expected_at, approved_at, ordered_at, received_at, cancelled_at, cancel_reason, created_at, suppliers(name)",
      )
      .eq("id", id)
      .maybeSingle(),
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

  // `null` aqui pode ser "não existe" ou "a policy escondeu" — a tela
  // responde igual nos dois casos, mesmo raciocínio já usado em
  // apps/web/app/importacoes/[id]/page.tsx.
  if (order.error !== null || order.data === null) {
    notFound();
  }

  const info = order.data;

  // Duas ausências distintas, e nenhuma delas é zero: falha de LEITURA e custo
  // não preenchido. O porquê e os casos estão em `lib/purchase-order-cost.ts`,
  // com teste. Somar em JavaScript aqui não é a agregação que `AGENTS.md`
  // proíbe: os itens já foram lidos para a tabela abaixo, então não há leitura
  // acrescentada — é a mesma linha, contada uma vez.
  const cost = summarizePurchaseOrderCost(items.error !== null ? null : items.data);
  const costNote = purchaseOrderCostNote(cost);

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
        <Stat label="Itens" value={items.error !== null ? "—" : String(items.data.length)} />
        {/*
          A ressalva fica AO LADO do número, nunca só no `title`
          (`docs/METRICS.md` 5C.2): um total que soma parte dos itens precisa
          dizer que é parcial na mesma linha em que se apresenta.
        */}
        {/*
          Spread condicional, não `note={... : undefined}`:
          `exactOptionalPropertyTypes` exige a chave de fato AUSENTE, não
          `undefined` atribuído — o mesmo motivo já registrado em
          `apps/web/app/notas-fiscais/actions.ts`.
        */}
        <Stat
          label="Valor estimado"
          value={formatCurrency(cost.total)}
          {...(costNote === null ? {} : { note: costNote })}
        />

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
