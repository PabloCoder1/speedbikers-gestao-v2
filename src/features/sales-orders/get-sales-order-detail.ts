import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { measureServerOperation } from "@/lib/observability/measure-server-operation";
import { createClient } from "@/lib/supabase/server";

export type SalesOrderDetailItem = {
  orderItemId: string;
  productId: string | null;
  sellerSku: string | null;
  itemId: string;
  variationId: string | null;
  title: string | null;
  quantity: number;
  unitPrice: number | null;
  fullUnitPrice: number | null;
  saleFee: number | null;
  permalink: string | null;
};

export type SalesOrderDetail = {
  orderId: string;
  externalOrderId: string;
  packId: string | null;
  shippingId: string | null;
  status: string;
  accountId: string;
  accountCode: string;
  accountDisplayName: string;
  totalAmount: number | null;
  paidAmount: number | null;
  currencyId: string | null;
  tags: unknown[];
  dateCreated: string | null;
  dateClosed: string | null;
  mlLastUpdated: string | null;
  items: SalesOrderDetailItem[];
};

function nullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

export async function getSalesOrderDetail(
  orderId: string,
): Promise<SalesOrderDetail | null> {
  return measureServerOperation("get_sales_order_detail", () =>
    getSalesOrderDetailImpl(orderId),
  );
}

async function getSalesOrderDetailImpl(
  orderId: string,
): Promise<SalesOrderDetail | null> {
  const access = await getCurrentAccess();
  if (!access) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_sales_order_detail", {
    target_organization_id: access.organizationId,
    target_order_id: orderId,
  });

  if (error) throw new Error(`SALES_ORDER_DETAIL_FAILED:${error.message}`);
  if (!data) return null;

  const result = data as Record<string, unknown>;
  const items = (result.items as Record<string, unknown>[] | undefined) ?? [];

  return {
    orderId: result.orderId as string,
    externalOrderId: result.externalOrderId as string,
    packId: nullableString(result.packId),
    shippingId: nullableString(result.shippingId),
    status: result.status as string,
    accountId: result.accountId as string,
    accountCode: result.accountCode as string,
    accountDisplayName: result.accountDisplayName as string,
    totalAmount: nullableNumber(result.totalAmount),
    paidAmount: nullableNumber(result.paidAmount),
    currencyId: nullableString(result.currencyId),
    tags: Array.isArray(result.tags) ? (result.tags as unknown[]) : [],
    dateCreated: nullableString(result.dateCreated),
    dateClosed: nullableString(result.dateClosed),
    mlLastUpdated: nullableString(result.mlLastUpdated),
    items: items.map((item) => ({
      orderItemId: item.orderItemId as string,
      productId: nullableString(item.productId),
      sellerSku: nullableString(item.sellerSku),
      itemId: item.itemId as string,
      variationId: nullableString(item.variationId),
      title: nullableString(item.title),
      quantity: nullableNumber(item.quantity) ?? 0,
      unitPrice: nullableNumber(item.unitPrice),
      fullUnitPrice: nullableNumber(item.fullUnitPrice),
      saleFee: nullableNumber(item.saleFee),
      permalink: nullableString(item.permalink),
    })),
  };
}
