import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { measureServerOperation } from "@/lib/observability/measure-server-operation";
import { createClient } from "@/lib/supabase/server";

export type SalesOrdersSummary = {
  orders: number;
  units: number;
  grossRevenue: number;
  paidAmount: number;
  saleFees: number;
  averageTicket: number;
};

function numberOrZero(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getSalesOrdersSummary(options: {
  fromIso: string;
  toIsoExclusive: string;
  accountId?: string | null;
}): Promise<SalesOrdersSummary | null> {
  return measureServerOperation("get_sales_orders_summary", () =>
    getSalesOrdersSummaryImpl(options),
  );
}

async function getSalesOrdersSummaryImpl(options: {
  fromIso: string;
  toIsoExclusive: string;
  accountId?: string | null;
}): Promise<SalesOrdersSummary | null> {
  const access = await getCurrentAccess();
  if (!access) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_sales_orders_summary", {
    target_organization_id: access.organizationId,
    date_from: options.fromIso,
    date_to: options.toIsoExclusive,
    target_ml_account_id: options.accountId ?? null,
  });

  if (error) throw new Error(`SALES_ORDERS_SUMMARY_FAILED:${error.message}`);

  const result = (data ?? {}) as Record<string, unknown>;
  const orders = numberOrZero(result.orders);
  const grossRevenue = numberOrZero(result.grossRevenue);

  return {
    orders,
    units: numberOrZero(result.units),
    grossRevenue,
    paidAmount: numberOrZero(result.paidAmount),
    saleFees: numberOrZero(result.saleFees),
    averageTicket: orders > 0 ? grossRevenue / orders : 0,
  };
}
