import "server-only";

import { describeRefreshOutcome } from "./refresh-outcome";
import { createAdminClient } from "@/lib/supabase/admin";

/*
 * Shared by both callers that touch orders — the orders_v2 refresh
 * burst (process-order-refresh-burst.ts) and the orders_recent
 * reconciliation path (sync-recent-orders.ts) — so the RPC's
 * non-blocking serialization (one advisory lock, whoever gets there
 * first wins) protects both call sites through the same code, not
 * two separate implementations.
 */
export async function refreshStockSaleDeductions(): Promise<void> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("refresh_stock_sale_deductions");

  const message = describeRefreshOutcome(data, error);
  if (message) {
    console.error(message);
  }
}
