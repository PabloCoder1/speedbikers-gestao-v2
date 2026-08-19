import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import type { SalesOrderDetail, SalesOrderDetailItem } from "@/features/sales-orders/get-sales-order-detail";
import { salesOrderStatusLabel } from "@/features/sales-orders/sales-order-status-label";

const numberFormatter = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const currencyFormatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  dateStyle: "short",
  timeStyle: "short",
});

function formatDateTime(value: string | null) {
  return value ? dateTimeFormatter.format(new Date(value)) : "—";
}

function formatMoney(value: number | null) {
  return value === null ? "—" : currencyFormatter.format(value);
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-1 text-sm font-semibold text-gray-950">{value}</p>
    </div>
  );
}

function usefulTags(tags: unknown[]) {
  return tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
}

export function SalesOrderDetailView({ detail }: { detail: SalesOrderDetail }) {
  const statusBadge = salesOrderStatusLabel(detail.status);
  const totalUnits = detail.items.reduce((sum, item) => sum + item.quantity, 0);
  const tags = usefulTags(detail.tags);

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader
        eyebrow="Pedidos de venda"
        title={`Pedido Mercado Livre #${detail.externalOrderId}`}
        actions={
          <Link
            href="/pedidos"
            className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-xs font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
          >
            ← Voltar
          </Link>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="info">{detail.accountDisplayName}</Badge>
            <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>
          </span>
        }
      />

      <Card className="mt-6 p-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Fact label="Criado" value={formatDateTime(detail.dateCreated)} />
          <Fact label="Fechado" value={formatDateTime(detail.dateClosed)} />
          <Fact label="Última atualização ML" value={formatDateTime(detail.mlLastUpdated)} />
          <Fact label="Pack" value={detail.packId ?? "—"} />
          <Fact label="Shipping" value={detail.shippingId ?? "—"} />
          <Fact label="Total" value={formatMoney(detail.totalAmount)} />
          <Fact label="Pago" value={formatMoney(detail.paidAmount)} />
          <Fact
            label="Taxas"
            value={currencyFormatter.format(detail.items.reduce((sum, item) => sum + (item.saleFee ?? 0), 0))}
          />
          <Fact label="Unidades" value={numberFormatter.format(totalUnits)} />
        </div>
      </Card>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-gray-100 px-6 py-4">
          <h2 className="text-sm font-semibold text-gray-900">Itens</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[1200px] w-full text-sm">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-400">
              <tr>
                <th className="px-4 py-3 text-left">Produto</th>
                <th className="px-4 py-3 text-left">Seller SKU</th>
                <th className="px-4 py-3 text-left">MLB</th>
                <th className="px-4 py-3 text-left">Variação</th>
                <th className="px-4 py-3 text-right">Quantidade</th>
                <th className="px-4 py-3 text-right">Preço unitário</th>
                <th className="px-4 py-3 text-right">Preço cheio</th>
                <th className="px-4 py-3 text-right">Taxa</th>
                <th className="px-4 py-3 text-right">Subtotal</th>
                <th className="px-4 py-3 text-left">Ação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {detail.items.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center text-sm text-gray-500">
                    Nenhum item ativo neste pedido.
                  </td>
                </tr>
              ) : (
                detail.items.map((item) => <SalesOrderItemRow key={item.orderItemId} item={item} />)
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-6 p-6">
        <h2 className="text-sm font-semibold text-gray-900">Dados operacionais</h2>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Fact label="Order ID" value={detail.orderId} />
          <Fact label="Pack ID" value={detail.packId ?? "—"} />
          <Fact label="Shipping ID" value={detail.shippingId ?? "—"} />
          <Fact label="Conta" value={detail.accountDisplayName} />
          <Fact label="Status" value={statusBadge.label} />
        </div>
        {tags.length > 0 ? (
          <div className="mt-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Tags</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {tags.map((tag) => (
                <Badge key={tag} variant="neutral">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function SalesOrderItemRow({ item }: { item: SalesOrderDetailItem }) {
  const subtotal = item.unitPrice !== null ? item.unitPrice * item.quantity : null;

  return (
    <tr className="text-sm">
      <td className="px-4 py-3">
        <p className="max-w-xs truncate font-medium text-gray-900" title={item.title ?? undefined}>
          {item.title ?? "—"}
        </p>
        {item.productId ? (
          <Link href={`/produto/${item.productId}`} className="text-xs font-semibold text-blue-700 hover:underline">
            Ver produto →
          </Link>
        ) : (
          <Badge variant="warning" className="mt-1">
            Produto não vinculado
          </Badge>
        )}
      </td>
      <td className="px-4 py-3 text-gray-700">{item.sellerSku ?? "—"}</td>
      <td className="px-4 py-3">
        {item.permalink ? (
          <a
            href={item.permalink}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-semibold text-blue-700 hover:underline"
          >
            {item.itemId}
          </a>
        ) : (
          <span className="text-gray-600">{item.itemId}</span>
        )}
      </td>
      <td className="px-4 py-3 text-gray-500">{item.variationId ?? "—"}</td>
      <td className="px-4 py-3 text-right">{numberFormatter.format(item.quantity)}</td>
      <td className="px-4 py-3 text-right">{formatMoney(item.unitPrice)}</td>
      <td className="px-4 py-3 text-right">{formatMoney(item.fullUnitPrice)}</td>
      <td className="px-4 py-3 text-right text-gray-600">{formatMoney(item.saleFee)}</td>
      <td className="px-4 py-3 text-right font-semibold">{subtotal === null ? "—" : currencyFormatter.format(subtotal)}</td>
      <td className="px-4 py-3">
        {item.productId ? (
          <Link href={`/produto/${item.productId}`} className="text-xs font-semibold text-blue-700 hover:underline">
            Ver produto
          </Link>
        ) : (
          <span className="text-xs text-gray-400">—</span>
        )}
      </td>
    </tr>
  );
}
