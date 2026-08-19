export type PurchaseOrderStatus =
  | "draft"
  | "approved"
  | "ordered"
  | "partially_received"
  | "received"
  | "cancelled";

export function computeOutstandingQuantity(
  quantityOrdered: number,
  receivedQuantity: number,
  cancelledQuantity: number,
) {
  return Math.max(quantityOrdered - receivedQuantity - cancelledQuantity, 0);
}

export function computeOverReceivedQuantity(quantityOrdered: number, receivedQuantity: number) {
  return Math.max(receivedQuantity - quantityOrdered, 0);
}

export function isOverdue(
  status: PurchaseOrderStatus,
  expectedAt: Date | null,
  outstandingQuantity: number,
  now: Date,
) {
  if (status !== "ordered" && status !== "partially_received") return false;
  if (!expectedAt) return false;
  if (outstandingQuantity <= 0) return false;
  return expectedAt.getTime() < now.getTime();
}

export type ItemReceiptState = { quantityOrdered: number; receivedQuantity: number; cancelledQuantity: number };

export function deriveStatusAfterReceipt(items: ItemReceiptState[]): PurchaseOrderStatus {
  if (items.length === 0) return "ordered";
  const anyReceived = items.some((item) => item.receivedQuantity > 0);
  const allSettled = items.every(
    (item) => item.quantityOrdered <= item.receivedQuantity + item.cancelledQuantity,
  );
  if (allSettled) return "received";
  if (anyReceived) return "partially_received";
  return "ordered";
}

export function computeCancelRemainingQuantity(quantityOrdered: number, receivedQuantity: number) {
  return Math.max(quantityOrdered - receivedQuantity, 0);
}

const VALID_TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  draft: ["approved", "cancelled"],
  approved: ["draft", "ordered", "cancelled"],
  ordered: ["partially_received", "received", "cancelled"],
  partially_received: ["received"],
  received: [],
  cancelled: [],
};

export function isValidTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus) {
  return VALID_TRANSITIONS[from].includes(to);
}

export function computeDefaultExpectedAt(orderedAt: Date, maxLeadTimeDays: number) {
  const result = new Date(orderedAt.getTime());
  result.setDate(result.getDate() + maxLeadTimeDays);
  return result;
}

export type TransitOrder = {
  status: PurchaseOrderStatus;
  transitAccountingSource: "internal" | "upseller_confirmed";
  outstandingQuantity: number;
};

export function computeInternalPurchaseInTransit(orders: TransitOrder[]) {
  return orders
    .filter((order) => order.status === "ordered" || order.status === "partially_received")
    .filter((order) => order.transitAccountingSource === "internal")
    .reduce((sum, order) => sum + order.outstandingQuantity, 0);
}

export function computeEffectivePurchaseInTransit(upsellerPurchaseInTransit: number, orders: TransitOrder[]) {
  return upsellerPurchaseInTransit + computeInternalPurchaseInTransit(orders);
}
