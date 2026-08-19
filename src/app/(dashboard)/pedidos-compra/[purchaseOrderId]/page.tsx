import { notFound, redirect } from "next/navigation";

import { PurchaseOrderDetailView } from "@/components/purchase-orders/purchase-order-detail-view";
import { getPurchaseOrderMutationAccess } from "@/features/auth/get-purchase-order-mutation-access";
import { getPurchaseOrderDetail } from "@/features/purchase-orders/get-purchase-order-detail";
import { getActiveSuppliers } from "@/features/purchase-orders/get-suppliers";
import { getCurrentAccess } from "@/features/auth/get-current-access";

export const metadata = {
  title: "Pedido de compra",
};

const NO_PERMISSIONS = {
  canCreateDraft: false,
  canEditDraft: false,
  canApprove: false,
  canReopen: false,
  canMarkOrdered: false,
  canCancel: false,
  canChangeTransitAccounting: false,
  canCancelRemaining: false,
  canReceiveNfe: false,
};

type PageProps = {
  params: Promise<{ purchaseOrderId: string }>;
};

export default async function PurchaseOrderDetailPage({ params }: PageProps) {
  const { purchaseOrderId } = await params;
  const access = await getCurrentAccess();
  if (!access) {
    redirect("/login");
  }

  const [detail, suppliers, mutationAccess] = await Promise.all([
    getPurchaseOrderDetail(purchaseOrderId),
    getActiveSuppliers(),
    getPurchaseOrderMutationAccess(),
  ]);

  if (!detail) {
    notFound();
  }

  return (
    <PurchaseOrderDetailView
      detail={detail}
      suppliers={suppliers}
      permissions={mutationAccess.permissions ?? NO_PERMISSIONS}
    />
  );
}
