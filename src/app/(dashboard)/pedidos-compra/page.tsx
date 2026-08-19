import { redirect } from "next/navigation";

import { PurchaseOrdersListView } from "@/components/purchase-orders/purchase-orders-list-view";
import { getPurchaseOrdersPage, getPurchaseOrdersSummary } from "@/features/purchase-orders/get-purchase-orders";

export const metadata = {
  title: "Pedidos de compra",
};

type PedidosCompraPageProps = {
  searchParams: Promise<{
    q?: string | string[];
    status?: string | string[];
  }>;
};

const allowedStatuses = new Set([
  "all",
  "draft",
  "approved",
  "ordered",
  "partially_received",
  "overdue",
  "received",
  "cancelled",
]);

export default async function PedidosCompraPage({ searchParams }: PedidosCompraPageProps) {
  const rawSearchParams = await searchParams;
  const rawQuery = Array.isArray(rawSearchParams.q) ? rawSearchParams.q[0] : rawSearchParams.q;
  const rawStatus = Array.isArray(rawSearchParams.status) ? rawSearchParams.status[0] : rawSearchParams.status;
  const query = rawQuery?.trim().slice(0, 100) ?? "";
  const status = allowedStatuses.has(rawStatus ?? "") ? (rawStatus as string) : "all";

  const [summary, page] = await Promise.all([
    getPurchaseOrdersSummary(),
    getPurchaseOrdersPage({ status, search: query, limit: 100 }),
  ]);

  if (!summary || !page) {
    redirect("/login");
  }

  return <PurchaseOrdersListView summary={summary} page={page} query={query} status={status} />;
}
