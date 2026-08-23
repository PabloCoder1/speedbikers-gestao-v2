import type { Database } from "@sb/db";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PurchaseOrderExportData {
  orderNumber: number;
  status: string;
  organizationName: string | null;
  organizationCnpj: string | null;
  supplierName: string | null;
  supplierDocument: string | null;
  destinationWarehouseName: string | null;
  currency: string;
  notes: string | null;
  expectedAt: string | null;
  approvedAt: string | null;
  orderedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  items: {
    skuSnapshot: string;
    titleSnapshot: string | null;
    isImported: boolean | null;
    quantityOrdered: number;
    unitCost: number | null;
  }[];
}

/**
 * Mesma leitura de `page.tsx` (RLS do usuário logado, Modelo A), com os
 * campos extras que só a exportação precisa (CNPJ da organização e do
 * fornecedor). `null` aqui pode ser "não existe" ou "a policy escondeu" —
 * quem chama trata os dois casos como 404, mesmo raciocínio já usado na tela.
 */
export async function loadPurchaseOrderExportData(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<PurchaseOrderExportData | null> {
  const order = await supabase
    .from("purchase_orders")
    .select(
      "order_number, status, destination_warehouse_name, currency, notes, expected_at, approved_at, ordered_at, received_at, created_at, organizations(name, cnpj), suppliers(name, document)",
    )
    .eq("id", id)
    .maybeSingle();

  if (order.error !== null || order.data === null) {
    return null;
  }

  const items = await supabase
    .from("purchase_order_items")
    .select("sku_snapshot, title_snapshot, quantity_ordered, unit_cost, skus(is_imported)")
    .eq("purchase_order_id", id)
    .order("position");

  const info = order.data;

  return {
    orderNumber: info.order_number,
    status: info.status,
    organizationName: info.organizations.name,
    organizationCnpj: info.organizations.cnpj,
    supplierName: info.suppliers?.name ?? null,
    supplierDocument: info.suppliers?.document ?? null,
    destinationWarehouseName: info.destination_warehouse_name,
    currency: info.currency,
    notes: info.notes,
    expectedAt: info.expected_at,
    approvedAt: info.approved_at,
    orderedAt: info.ordered_at,
    receivedAt: info.received_at,
    createdAt: info.created_at,
    items: (items.data ?? []).map((item) => ({
      skuSnapshot: item.sku_snapshot,
      titleSnapshot: item.title_snapshot,
      isImported: item.skus?.is_imported ?? null,
      quantityOrdered: item.quantity_ordered,
      unitCost: item.unit_cost,
    })),
  };
}
