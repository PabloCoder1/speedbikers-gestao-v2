import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { createClient } from "@/lib/supabase/server";

export type PurchaseOrdersSummary = {
  drafts: number;
  awaitingApproval: number;
  inTransit: number;
  overdue: number;
  receivedInPeriod: number;
  openValue: number;
};

export type PurchaseOrderListRow = {
  purchaseOrderId: string;
  orderNumber: string;
  supplierName: string | null;
  status: string;
  itemCount: number;
  unitsOrdered: number;
  unitsReceived: number;
  unitsOutstanding: number;
  totalValue: number;
  orderedAt: string | null;
  expectedAt: string | null;
  overdue: boolean;
};

export type PurchaseOrdersPage = {
  rows: PurchaseOrderListRow[];
  matchCount: number;
};

function numberOrZero(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getPurchaseOrdersSummary(): Promise<PurchaseOrdersSummary | null> {
  const access = await getCurrentAccess();
  if (!access) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_purchase_orders_summary", {
    target_organization_id: access.organizationId,
  });

  if (error) throw new Error(`PURCHASE_ORDERS_SUMMARY_FAILED:${error.message}`);

  const result = (data ?? {}) as Record<string, unknown>;
  return {
    drafts: numberOrZero(result.drafts),
    awaitingApproval: numberOrZero(result.awaitingApproval),
    inTransit: numberOrZero(result.inTransit),
    overdue: numberOrZero(result.overdue),
    receivedInPeriod: numberOrZero(result.receivedInPeriod),
    openValue: numberOrZero(result.openValue),
  };
}

export async function getPurchaseOrdersPage(options: {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<PurchaseOrdersPage | null> {
  const access = await getCurrentAccess();
  if (!access) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_purchase_orders_page", {
    target_organization_id: access.organizationId,
    search_query: options.search?.trim() ?? "",
    status_filter: options.status && options.status !== "all" ? options.status : "all",
    result_limit: options.limit ?? 100,
    result_offset: options.offset ?? 0,
  });

  if (error) throw new Error(`PURCHASE_ORDERS_PAGE_FAILED:${error.message}`);

  const result = (data ?? {}) as { matchCount?: number; items?: Record<string, unknown>[] };
  const rows: PurchaseOrderListRow[] = (result.items ?? []).map((row) => ({
    purchaseOrderId: row.purchaseOrderId as string,
    orderNumber: row.orderNumber as string,
    supplierName: (row.supplierName as string | null) ?? null,
    status: row.status as string,
    itemCount: numberOrZero(row.itemCount),
    unitsOrdered: numberOrZero(row.unitsOrdered),
    unitsReceived: numberOrZero(row.unitsReceived),
    unitsOutstanding: numberOrZero(row.unitsOutstanding),
    totalValue: numberOrZero(row.totalValue),
    orderedAt: (row.orderedAt as string | null) ?? null,
    expectedAt: (row.expectedAt as string | null) ?? null,
    overdue: row.overdue === true,
  }));

  return { rows, matchCount: numberOrZero(result.matchCount) };
}
