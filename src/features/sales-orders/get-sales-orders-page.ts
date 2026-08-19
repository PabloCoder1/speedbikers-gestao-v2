import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { measureServerOperation } from "@/lib/observability/measure-server-operation";
import { createClient } from "@/lib/supabase/server";

export type SalesOrderStatusFilter = "all" | "paid" | "cancelled" | "attention";

export type SalesOrderListRow = {
  orderId: string;
  externalOrderId: string;
  packId: string | null;
  accountId: string;
  accountCode: string;
  accountDisplayName: string;
  dateCreated: string | null;
  status: string;
  totalAmount: number | null;
  paidAmount: number | null;
  shippingId: string | null;
  units: number;
  saleFees: number;
  itemCount: number;
  firstItemTitle: string | null;
  firstItemSellerSku: string | null;
  needsAttention: boolean;
};

export type SalesOrdersPageCursor = {
  dateCreated: string;
  orderId: string;
};

export type SalesOrdersPage = {
  rows: SalesOrderListRow[];
  hasMore: boolean;
  nextCursor: SalesOrdersPageCursor | null;
};

function numberOrZero(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

export async function getSalesOrdersPage(options: {
  fromIso: string;
  toIsoExclusive: string;
  accountId?: string | null;
  status?: SalesOrderStatusFilter | string;
  search?: string;
  cursorDate?: string | null;
  cursorId?: string | null;
  pageSize?: number;
}): Promise<SalesOrdersPage | null> {
  return measureServerOperation("get_sales_orders_page", () =>
    getSalesOrdersPageImpl(options),
  );
}

async function getSalesOrdersPageImpl(options: {
  fromIso: string;
  toIsoExclusive: string;
  accountId?: string | null;
  status?: SalesOrderStatusFilter | string;
  search?: string;
  cursorDate?: string | null;
  cursorId?: string | null;
  pageSize?: number;
}): Promise<SalesOrdersPage | null> {
  const access = await getCurrentAccess();
  if (!access) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_sales_orders_page", {
    target_organization_id: access.organizationId,
    date_from: options.fromIso,
    date_to: options.toIsoExclusive,
    target_ml_account_id: options.accountId ?? null,
    status_filter: options.status && options.status !== "all" ? options.status : "all",
    search_query: options.search?.trim() ?? "",
    cursor_date: options.cursorDate ?? null,
    cursor_id: options.cursorId ?? null,
    page_size: options.pageSize ?? 50,
  });

  if (error) throw new Error(`SALES_ORDERS_PAGE_FAILED:${error.message}`);

  const result = (data ?? {}) as {
    items?: Record<string, unknown>[];
    hasMore?: boolean;
    nextCursor?: { dateCreated?: string; orderId?: string } | null;
  };

  const rows: SalesOrderListRow[] = (result.items ?? []).map((row) => ({
    orderId: row.orderId as string,
    externalOrderId: row.externalOrderId as string,
    packId: nullableString(row.packId),
    accountId: row.accountId as string,
    accountCode: row.accountCode as string,
    accountDisplayName: row.accountDisplayName as string,
    dateCreated: nullableString(row.dateCreated),
    status: row.status as string,
    totalAmount: nullableNumber(row.totalAmount),
    paidAmount: nullableNumber(row.paidAmount),
    shippingId: nullableString(row.shippingId),
    units: numberOrZero(row.units),
    saleFees: numberOrZero(row.saleFees),
    itemCount: numberOrZero(row.itemCount),
    firstItemTitle: nullableString(row.firstItemTitle),
    firstItemSellerSku: nullableString(row.firstItemSellerSku),
    needsAttention: row.needsAttention === true,
  }));

  const nextCursor =
    result.nextCursor && result.nextCursor.dateCreated && result.nextCursor.orderId
      ? { dateCreated: result.nextCursor.dateCreated, orderId: result.nextCursor.orderId }
      : null;

  return {
    rows,
    hasMore: result.hasMore === true,
    nextCursor,
  };
}
