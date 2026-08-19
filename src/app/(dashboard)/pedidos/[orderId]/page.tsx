import { notFound, redirect } from "next/navigation";

import { SalesOrderDetailView } from "@/components/sales-orders/sales-order-detail-view";
import { getCurrentAccess } from "@/features/auth/get-current-access";
import { getSalesOrderDetail } from "@/features/sales-orders/get-sales-order-detail";

export const metadata = {
  title: "Detalhe do pedido",
};

type PedidoDetailPageProps = {
  params: Promise<{ orderId: string }>;
};

export default async function PedidoDetailPage({ params }: PedidoDetailPageProps) {
  const { orderId } = await params;

  const access = await getCurrentAccess();
  if (!access) redirect("/login");

  const detail = await getSalesOrderDetail(orderId);
  if (!detail) notFound();

  return <SalesOrderDetailView detail={detail} />;
}
