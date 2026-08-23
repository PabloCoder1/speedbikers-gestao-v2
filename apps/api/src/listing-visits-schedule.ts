import type { AdminClient } from "@sb/db";
import { toSalesMetricDate } from "@sb/domain";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho da sincronização de visitas por anúncio (D-032) — chamado pelo
 * Cloud Scheduler, mesmo formato de `listings-schedule.ts`, mas por CONTA
 * (visita pertence a uma conta Mercado Livre específica) com cadência
 * DIÁRIA (não 6h): visita não é um dado operacional urgente como estoque —
 * `fetchListingVisits` já busca `last=3` dias a cada rodada, absorvendo uma
 * rodada diária perdida sem esperar até o dia seguinte.
 */

export interface ListingVisitsScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface ListingVisitsScheduleOutcome {
  accountsScanned: number;
  enqueued: number;
  deduplicated: number;
}

export async function triggerListingVisitsSnapshot(
  deps: ListingVisitsScheduleDeps,
): Promise<ListingVisitsScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  const businessDate = toSalesMetricDate(now);

  const accounts = await deps.db
    .from("ml_accounts")
    .select("id, organization_id, slug")
    .eq("status", "CONNECTED");

  if (accounts.error !== null) {
    deps.logger.error("listing_visits_schedule_accounts_not_listed", { reason: accounts.error.message });

    return { accountsScanned: 0, enqueued: 0, deduplicated: 0 };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const account of accounts.data) {
    const result = await deps.enqueuer.enqueue({
      jobType: "sync.listing-visits.snapshot",
      organizationId: account.organization_id,
      dedupeKey: `listing-visits:${account.slug}:${businessDate}`,
      queue: `ml-sync-${account.slug}`,
      payload: { mlAccountId: account.id },
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("listing_visits_schedule_triggered", {
    accounts_scanned: accounts.data.length,
    enqueued,
    deduplicated,
  });

  return { accountsScanned: accounts.data.length, enqueued, deduplicated };
}
