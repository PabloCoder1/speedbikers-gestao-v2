export type SalesOrderStatusBadgeVariant = "success" | "danger" | "warning" | "info" | "neutral";

export type SalesOrderStatusLabel = {
  label: string;
  variant: SalesOrderStatusBadgeVariant;
};

/*
 * Only the statuses actually observed in public.orders as of ETAPA 34
 * (select status, count(*) from orders group by status: paid,
 * cancelled, partially_refunded, pending_cancel). This is a purely
 * visual translation layer — orders.status itself is never rewritten.
 * Any future/unknown status falls through to its own raw value so a
 * new Mercado Livre status never disappears from the UI.
 */
const STATUS_LABELS: Record<string, SalesOrderStatusLabel> = {
  paid: { label: "Pago", variant: "success" },
  cancelled: { label: "Cancelado", variant: "danger" },
  partially_refunded: { label: "Parcialmente reembolsado", variant: "warning" },
  pending_cancel: { label: "Cancelamento em andamento", variant: "warning" },
};

export function salesOrderStatusLabel(status: string): SalesOrderStatusLabel {
  return STATUS_LABELS[status] ?? { label: status, variant: "neutral" };
}
