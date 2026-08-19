import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { measureServerOperation } from "@/lib/observability/measure-server-operation";
import { createClient } from "@/lib/supabase/server";

/*
 * Reusable read model for ETAPA 35's diagnostic assistant — sources
 * exclusively from daily_product_metrics (never re-scans raw orders).
 * No analysis or text generation happens here.
 */
export type ProductSalesTimelineEvent = {
  metricDate: string;
  unitsSold: number;
  ordersCount: number;
  grossRevenue: number;
  saleFees: number;
  netAfterSaleFee: number;
};

function numberOrZero(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getProductSalesTimelineEvents(options: {
  productId: string;
  dateFromKey: string;
  dateToKey: string;
  accountId?: string | null;
}): Promise<ProductSalesTimelineEvent[] | null> {
  return measureServerOperation("get_product_sales_timeline_events", () =>
    getProductSalesTimelineEventsImpl(options),
  );
}

async function getProductSalesTimelineEventsImpl(options: {
  productId: string;
  dateFromKey: string;
  dateToKey: string;
  accountId?: string | null;
}): Promise<ProductSalesTimelineEvent[] | null> {
  const access = await getCurrentAccess();
  if (!access) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_product_sales_timeline_events", {
    target_organization_id: access.organizationId,
    target_product_id: options.productId,
    date_from: options.dateFromKey,
    date_to: options.dateToKey,
    target_ml_account_id: options.accountId ?? null,
  });

  if (error) throw new Error(`PRODUCT_SALES_TIMELINE_FAILED:${error.message}`);

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    metricDate: row.metricDate as string,
    unitsSold: numberOrZero(row.unitsSold),
    ordersCount: numberOrZero(row.ordersCount),
    grossRevenue: numberOrZero(row.grossRevenue),
    saleFees: numberOrZero(row.saleFees),
    netAfterSaleFee: numberOrZero(row.netAfterSaleFee),
  }));
}
