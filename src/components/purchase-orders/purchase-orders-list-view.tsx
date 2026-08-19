import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { PageHeader } from "@/components/ui/page-header";
import type { PurchaseOrderListRow, PurchaseOrdersPage, PurchaseOrdersSummary } from "@/features/purchase-orders/get-purchase-orders";

const numberFormatter = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const currencyFormatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateFormatter = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short" });

const filters: { value: string; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "draft", label: "Rascunhos" },
  { value: "approved", label: "Aprovados" },
  { value: "ordered", label: "Em trânsito" },
  { value: "partially_received", label: "Parciais" },
  { value: "overdue", label: "Atrasados" },
  { value: "received", label: "Recebidos" },
  { value: "cancelled", label: "Cancelados" },
];

const statusBadge: Record<string, { label: string; variant: "neutral" | "info" | "warning" | "success" | "danger" }> = {
  draft: { label: "Rascunho", variant: "neutral" },
  approved: { label: "Aprovado", variant: "info" },
  ordered: { label: "Em trânsito", variant: "warning" },
  partially_received: { label: "Parcial", variant: "warning" },
  received: { label: "Recebido", variant: "success" },
  cancelled: { label: "Cancelado", variant: "danger" },
};

function formatDate(value: string | null) {
  return value ? dateFormatter.format(new Date(value)) : "—";
}

export function PurchaseOrdersListView({
  summary,
  page,
  query,
  status,
}: {
  summary: PurchaseOrdersSummary;
  page: PurchaseOrdersPage;
  query: string;
  status: string;
}) {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader
        eyebrow="Operação"
        title="Pedidos de compra"
        description="Acompanhe pedidos de compra desde o rascunho até o recebimento, com trânsito e valores em aberto."
        actions={
          <Link
            href="/compras"
            className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-xs font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
          >
            Ir para planejamento de compras
          </Link>
        }
      />

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <MetricCard label="Rascunhos" value={numberFormatter.format(summary.drafts)} />
        <MetricCard label="Aprovados" value={numberFormatter.format(summary.awaitingApproval)} />
        <MetricCard label="Em trânsito" value={numberFormatter.format(summary.inTransit)} />
        <MetricCard
          label="Atrasados"
          value={numberFormatter.format(summary.overdue)}
          badge={summary.overdue > 0 ? <Badge variant="danger">Atenção</Badge> : undefined}
        />
        <MetricCard label="Recebidos (30d)" value={numberFormatter.format(summary.receivedInPeriod)} />
        <MetricCard label="Valor aberto" value={currencyFormatter.format(summary.openValue)} />
      </div>

      <Card className="mt-6 p-4">
        <form className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" method="get">
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Buscar por número, fornecedor ou SKU"
            className="w-full max-w-sm rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 focus:border-gray-400 focus:bg-white focus:ring-4 focus:ring-gray-100"
          />
          <input type="hidden" name="status" value={status} />
          <nav className="flex flex-wrap gap-2">
            {filters.map((filter) => (
              <Link
                key={filter.value}
                href={`/pedidos-compra?status=${filter.value}${query ? `&q=${encodeURIComponent(query)}` : ""}`}
                aria-current={status === filter.value ? "page" : undefined}
                className={`rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                  status === filter.value
                    ? "border-gray-950 bg-gray-950 text-white"
                    : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                {filter.label}
              </Link>
            ))}
          </nav>
        </form>
      </Card>

      <p className="mt-4 text-xs text-gray-500">{page.matchCount} pedido(s) encontrado(s).</p>

      <Card className="mt-2 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-[1100px] w-full text-sm">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-400">
              <tr>
                <th className="px-4 py-3 text-left">Pedido</th>
                <th className="px-4 py-3 text-left">Fornecedor</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-right">Itens</th>
                <th className="px-4 py-3 text-right">Unidades</th>
                <th className="px-4 py-3 text-right">Recebidas</th>
                <th className="px-4 py-3 text-right">Pendentes</th>
                <th className="px-4 py-3 text-right">Valor</th>
                <th className="px-4 py-3 text-left">Pedido em</th>
                <th className="px-4 py-3 text-left">Previsão</th>
                <th className="px-4 py-3 text-left">Situação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {page.rows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-10 text-center text-sm text-gray-500">
                    Nenhum pedido encontrado para os filtros atuais.
                  </td>
                </tr>
              ) : (
                page.rows.map((row: PurchaseOrderListRow) => {
                  const badge = statusBadge[row.status] ?? statusBadge.draft;
                  return (
                    <tr key={row.purchaseOrderId} className="text-sm">
                      <td className="px-4 py-3">
                        <Link href={`/pedidos-compra/${row.purchaseOrderId}`} className="font-semibold text-blue-700 hover:underline">
                          {row.orderNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-gray-700">{row.supplierName ?? "—"}</td>
                      <td className="px-4 py-3">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </td>
                      <td className="px-4 py-3 text-right">{numberFormatter.format(row.itemCount)}</td>
                      <td className="px-4 py-3 text-right">{numberFormatter.format(row.unitsOrdered)}</td>
                      <td className="px-4 py-3 text-right">{numberFormatter.format(row.unitsReceived)}</td>
                      <td className="px-4 py-3 text-right">{numberFormatter.format(row.unitsOutstanding)}</td>
                      <td className="px-4 py-3 text-right">{currencyFormatter.format(row.totalValue)}</td>
                      <td className="px-4 py-3 text-gray-600">{formatDate(row.orderedAt)}</td>
                      <td className="px-4 py-3 text-gray-600">{formatDate(row.expectedAt)}</td>
                      <td className="px-4 py-3">
                        {row.overdue ? <Badge variant="danger">Atrasado</Badge> : <span className="text-gray-400">—</span>}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
