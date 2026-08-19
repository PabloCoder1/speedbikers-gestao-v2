import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { PageHeader } from "@/components/ui/page-header";
import type { MlAccount } from "@/features/ml-accounts/get-ml-accounts";
import type { SalesOrderListRow, SalesOrdersPage } from "@/features/sales-orders/get-sales-orders-page";
import type { SalesOrdersSummary } from "@/features/sales-orders/get-sales-orders-summary";
import { salesOrderStatusLabel } from "@/features/sales-orders/sales-order-status-label";

const numberFormatter = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const currencyFormatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  dateStyle: "short",
  timeStyle: "short",
});

const periodPresets: { value: string; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "yesterday", label: "Ontem" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
];

const statusFilters: { value: string; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "paid", label: "Pagos" },
  { value: "cancelled", label: "Cancelados" },
  { value: "attention", label: "Com atenção" },
];

function formatDateTime(value: string | null) {
  return value ? dateTimeFormatter.format(new Date(value)) : "—";
}

function buildHref(base: Record<string, string | undefined>, overrides: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  const merged = { ...base, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value) params.set(key, value);
  }
  const suffix = params.toString();
  return suffix ? `/pedidos?${suffix}` : "/pedidos";
}

function productsSummary(row: SalesOrderListRow) {
  if (row.itemCount === 0) return "—";
  const first = row.firstItemTitle ?? row.firstItemSellerSku ?? "Item sem título";
  if (row.itemCount === 1) {
    return row.firstItemSellerSku ? `${row.firstItemSellerSku} — ${first}` : first;
  }
  return `${first} + ${row.itemCount - 1} item(ns)`;
}

export function SalesOrdersListView({
  summary,
  page,
  accounts,
  selectedAccountCode,
  preset,
  fromDateKey,
  toDateKey,
  status,
  query,
  pageSize,
}: {
  summary: SalesOrdersSummary;
  page: SalesOrdersPage;
  accounts: MlAccount[];
  selectedAccountCode: string;
  preset: string;
  fromDateKey: string;
  toDateKey: string;
  status: string;
  query: string;
  pageSize: number;
}) {
  const baseParams = {
    periodo: preset,
    de: preset === "custom" ? fromDateKey : undefined,
    ate: preset === "custom" ? toDateKey : undefined,
    conta: selectedAccountCode !== "all" ? selectedAccountCode : undefined,
    status: status !== "all" ? status : undefined,
    q: query || undefined,
    tamanho: pageSize !== 50 ? String(pageSize) : undefined,
  };

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader
        eyebrow="Operação"
        title="Pedidos de venda"
        description="O que vendeu, em qual conta, quais produtos e quais pedidos precisam de atenção."
      />

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <MetricCard label="Pedidos" value={numberFormatter.format(summary.orders)} />
        <MetricCard label="Unidades" value={numberFormatter.format(summary.units)} />
        <MetricCard label="Faturamento bruto" value={currencyFormatter.format(summary.grossRevenue)} />
        <MetricCard label="Valor pago" value={currencyFormatter.format(summary.paidAmount)} />
        <MetricCard label="Taxas de venda" value={currencyFormatter.format(summary.saleFees)} />
        <MetricCard label="Ticket médio" value={currencyFormatter.format(summary.averageTicket)} />
      </div>

      <Card className="mt-6 p-4">
        <form className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" method="get">
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Buscar por pedido, pack, SKU, título ou MLB"
            className="w-full max-w-sm rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 focus:border-gray-400 focus:bg-white focus:ring-4 focus:ring-gray-100"
          />
          <input type="hidden" name="periodo" value={preset === "custom" ? "custom" : preset} />
          {preset === "custom" ? <input type="hidden" name="de" value={fromDateKey} /> : null}
          {preset === "custom" ? <input type="hidden" name="ate" value={toDateKey} /> : null}
          <input type="hidden" name="status" value={status} />
          <select
            name="conta"
            defaultValue={selectedAccountCode}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700"
          >
            <option value="all">Todas as contas</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.code}>
                {account.displayName}
              </option>
            ))}
          </select>
        </form>

        <nav className="mt-3 flex flex-wrap items-center gap-2">
          {periodPresets.map((option) => (
            <Link
              key={option.value}
              href={buildHref(baseParams, { periodo: option.value, de: undefined, ate: undefined, cd: undefined, ci: undefined })}
              aria-current={preset === option.value ? "page" : undefined}
              className={`rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                preset === option.value
                  ? "border-gray-950 bg-gray-950 text-white"
                  : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              {option.label}
            </Link>
          ))}

          <span className="mx-1 text-gray-300">|</span>

          <form className="flex items-center gap-2" method="get">
            <input type="hidden" name="periodo" value="custom" />
            <input type="hidden" name="status" value={status} />
            {query ? <input type="hidden" name="q" value={query} /> : null}
            {selectedAccountCode !== "all" ? <input type="hidden" name="conta" value={selectedAccountCode} /> : null}
            <label className="flex items-center gap-2 text-xs text-gray-600">
              <input
                type="date"
                name="de"
                defaultValue={preset === "custom" ? fromDateKey : ""}
                className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
              />
              até
              <input
                type="date"
                name="ate"
                defaultValue={preset === "custom" ? toDateKey : ""}
                className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
              />
            </label>
            <button
              type="submit"
              className="rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
            >
              Aplicar período
            </button>
          </form>
        </nav>

        <nav className="mt-3 flex flex-wrap gap-2">
          {statusFilters.map((option) => (
            <Link
              key={option.value}
              href={buildHref(baseParams, { status: option.value, cd: undefined, ci: undefined })}
              aria-current={status === option.value ? "page" : undefined}
              className={`rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                status === option.value
                  ? "border-gray-950 bg-gray-950 text-white"
                  : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              {option.label}
            </Link>
          ))}
        </nav>
      </Card>

      <p className="mt-4 text-xs text-gray-500">{page.rows.length} pedido(s) nesta página.</p>

      <Card className="mt-2 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-[1200px] w-full text-sm">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-400">
              <tr>
                <th className="px-4 py-3 text-left">Pedido</th>
                <th className="px-4 py-3 text-left">Conta</th>
                <th className="px-4 py-3 text-left">Criado em</th>
                <th className="px-4 py-3 text-left">Produtos</th>
                <th className="px-4 py-3 text-right">Unidades</th>
                <th className="px-4 py-3 text-right">Valor</th>
                <th className="px-4 py-3 text-right">Pago</th>
                <th className="px-4 py-3 text-right">Taxas</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Envio</th>
                <th className="px-4 py-3 text-left">Ação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {page.rows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-10 text-center text-sm text-gray-500">
                    Nenhum pedido encontrado para o período e filtros atuais.
                  </td>
                </tr>
              ) : (
                page.rows.map((row) => {
                  const badge = salesOrderStatusLabel(row.status);
                  return (
                    <tr key={row.orderId} className="text-sm">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-gray-950">#{row.externalOrderId}</div>
                        {row.packId ? <div className="text-xs text-gray-400">Pack: {row.packId}</div> : null}
                        {row.needsAttention ? (
                          <Badge variant="warning" className="mt-1">
                            Atenção
                          </Badge>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="info">{row.accountDisplayName}</Badge>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{formatDateTime(row.dateCreated)}</td>
                      <td className="px-4 py-3 max-w-xs truncate text-gray-700" title={productsSummary(row)}>
                        {productsSummary(row)}
                      </td>
                      <td className="px-4 py-3 text-right">{numberFormatter.format(row.units)}</td>
                      <td className="px-4 py-3 text-right">
                        {row.totalAmount === null ? "—" : currencyFormatter.format(row.totalAmount)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {row.paidAmount === null ? "—" : currencyFormatter.format(row.paidAmount)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">{currencyFormatter.format(row.saleFees)}</td>
                      <td className="px-4 py-3">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </td>
                      <td className="px-4 py-3 text-gray-500">{row.shippingId ?? "—"}</td>
                      <td className="px-4 py-3">
                        <Link href={`/pedidos/${row.orderId}`} className="font-semibold text-blue-700 hover:underline">
                          Ver pedido →
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 flex items-center justify-end">
        {page.hasMore && page.nextCursor ? (
          <Link
            href={buildHref(baseParams, { cd: page.nextCursor.dateCreated, ci: page.nextCursor.orderId })}
            className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-xs font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
          >
            Próxima página →
          </Link>
        ) : null}
      </div>
    </div>
  );
}
