import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { createClient } from "@/lib/supabase/server";

export type PurchaseOrderHeader = {
  purchaseOrderId: string;
  orderNumber: string;
  status: string;
  transitAccountingSource: "internal" | "upseller_confirmed";
  supplierId: string | null;
  supplierName: string | null;
  supplierDocument: string | null;
  destinationWarehouseKey: string | null;
  destinationWarehouseName: string | null;
  currency: string;
  notes: string | null;
  expectedAt: string | null;
  approvedAt: string | null;
  orderedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  version: number;
};

export type PurchaseOrderItemDetail = {
  purchaseOrderItemId: string;
  sourceSku: string;
  sourceSkuKey: string;
  titleSnapshot: string | null;
  brandSnapshot: string | null;
  quantityOrdered: number;
  cancelledQuantity: number;
  unitCost: number | null;
  receivedQuantity: number;
  outstandingQuantity: number;
  overReceivedQuantity: number;
  suggestedQuantitySnapshot: number | null;
  physicalAvailableSnapshot: number | null;
  upsellerPurchaseInTransitSnapshot: number | null;
  avgDailySales30Snapshot: number | null;
  leadTimeDaysSnapshot: number | null;
  lowStockThresholdSnapshot: number | null;
  projectedStockAtArrivalSnapshot: number | null;
  planningStatusSnapshot: string | null;
  planningGeneratedAt: string | null;
};

export type PurchaseOrderEventDetail = {
  eventType: string;
  actorUserId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type PurchaseOrderReceiptItem = {
  sourceSku: string;
  skuKey: string;
  quantity: number;
  unitValue: number | null;
  totalValue: number | null;
};

export type PurchaseOrderReceiptDetail = {
  receiptId: string;
  invoiceNumber: string;
  appliedAt: string;
  totalAmount: number | null;
  items: PurchaseOrderReceiptItem[];
};

export type PurchaseOrderDetail = PurchaseOrderHeader & {
  items: PurchaseOrderItemDetail[];
  events: PurchaseOrderEventDetail[];
  receipts: PurchaseOrderReceiptDetail[];
};

export async function getPurchaseOrderDetail(purchaseOrderId: string): Promise<PurchaseOrderDetail | null> {
  const access = await getCurrentAccess();
  if (!access) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_purchase_order_detail", {
    target_organization_id: access.organizationId,
    target_purchase_order_id: purchaseOrderId,
  });

  if (error) throw new Error(`PURCHASE_ORDER_DETAIL_FAILED:${error.message}`);
  if (!data) return null;

  return data as PurchaseOrderDetail;
}
