import type { AdminClient } from "@sb/db";
import { toSalesMetricDate } from "@sb/domain";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho da captura de custos por pedido (D-165) — chamado pelo Cloud
 * Scheduler, mesmo formato de `listing-visits-schedule.ts`: por CONTA (o
 * custo pertence a uma conta Mercado Livre) e DIÁRIO — a varredura cobre os
 * últimos 7 dias a cada rodada, então uma rodada perdida se autocorrige na
 * seguinte, e custo de pedido não é dado operacional urgente.
 */

export interface OrderFinancialsScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface OrderFinancialsScheduleOutcome {
  accountsScanned: number;
  enqueued: number;
  deduplicated: number;
}

export async function triggerOrderFinancialsSweep(
  deps: OrderFinancialsScheduleDeps,
): Promise<OrderFinancialsScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  const businessDate = toSalesMetricDate(now);

  const accounts = await deps.db
    .from("ml_accounts")
    .select("id, organization_id, slug")
    .eq("status", "CONNECTED");

  if (accounts.error !== null) {
    deps.logger.error("order_financials_schedule_accounts_not_listed", { reason: accounts.error.message });

    return { accountsScanned: 0, enqueued: 0, deduplicated: 0 };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const account of accounts.data) {
    const result = await deps.enqueuer.enqueue({
      jobType: "sync.order-financials",
      organizationId: account.organization_id,
      dedupeKey: `order-financials:${account.slug}:${businessDate}`,
      queue: `ml-sync-${account.slug}`,
      payload: { mlAccountId: account.id },
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("order_financials_schedule_triggered", {
    accounts_scanned: accounts.data.length,
    enqueued,
    deduplicated,
  });

  return { accountsScanned: accounts.data.length, enqueued, deduplicated };
}
