import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho da sincronização de listings/anúncios (D-058) — chamado pelo
 * Cloud Scheduler, mesmo formato de `fulfillment-schedule.ts`.
 *
 * Cadência a cada 6h, mesmo raciocínio de Full: um anúncio não muda tão
 * rápido quanto pedidos, e mais conservador com o orçamento de rate limit
 * não documentado (D-042) do que copiar a cadência horária sem necessidade.
 */

export interface ListingsScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface ListingsScheduleOutcome {
  accountsScanned: number;
  enqueued: number;
  deduplicated: number;
}

export async function triggerListingsSnapshot(deps: ListingsScheduleDeps): Promise<ListingsScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  const windowBucket = now.toISOString().slice(0, 13);

  const accounts = await deps.db
    .from("ml_accounts")
    .select("id, organization_id, slug")
    .eq("status", "CONNECTED");

  if (accounts.error !== null) {
    deps.logger.error("listings_schedule_accounts_not_listed", { reason: accounts.error.message });

    return { accountsScanned: 0, enqueued: 0, deduplicated: 0 };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const account of accounts.data) {
    const result = await deps.enqueuer.enqueue({
      jobType: "sync.listings.snapshot",
      organizationId: account.organization_id,
      dedupeKey: `listings:${account.slug}:${windowBucket}`,
      queue: `ml-sync-${account.slug}`,
      payload: { mlAccountId: account.id },
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("listings_schedule_triggered", {
    accounts_scanned: accounts.data.length,
    enqueued,
    deduplicated,
  });

  return { accountsScanned: accounts.data.length, enqueued, deduplicated };
}
