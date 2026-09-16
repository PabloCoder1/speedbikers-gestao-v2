import type { AdminClient } from "@sb/db";
import { toSalesMetricDate } from "@sb/domain";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Agendamento diário do Mercado Ads (D-363): uma task `sync.ads.campaigns` por
 * conta CONNECTED, na fila da própria conta — o mesmo desenho de
 * `listing-visits-schedule.ts`.
 *
 * A cadência (`infra/cloud-scheduler.sh`, `v3-ads-campaigns-sync`) fica DEPOIS
 * das 10h: a doc de Product Ads diz que as métricas são atualizadas às 10h
 * (GMT-3). O escalonamento entre contas é menor que o das visitas porque o
 * trabalho por conta é pequeno (uma chamada por campanha), mas continua
 * existindo: o limite de taxa do Mercado Livre é por aplicativo (D-171).
 */

const ACCOUNT_STAGGER_SECONDS = 300;

export interface AdsScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface AdsScheduleOutcome {
  accountsScanned: number;
  enqueued: number;
  deduplicated: number;
}

export async function triggerAdsCampaignsSync(deps: AdsScheduleDeps): Promise<AdsScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  const businessDate = toSalesMetricDate(now);

  const accounts = await deps.db
    .from("ml_accounts")
    .select("id, organization_id, slug")
    .eq("status", "CONNECTED");

  if (accounts.error !== null) {
    deps.logger.error("ads_schedule_accounts_not_listed", { reason: accounts.error.message });

    return { accountsScanned: 0, enqueued: 0, deduplicated: 0 };
  }

  let enqueued = 0;
  let deduplicated = 0;

  const ordered = [...accounts.data].sort((a, b) => a.slug.localeCompare(b.slug));

  for (const [index, account] of ordered.entries()) {
    const delaySeconds = index * ACCOUNT_STAGGER_SECONDS;

    const result = await deps.enqueuer.enqueue({
      jobType: "sync.ads.campaigns",
      organizationId: account.organization_id,
      dedupeKey: `ads:${account.slug}:${businessDate}`,
      queue: `ml-sync-${account.slug}`,
      payload: { mlAccountId: account.id },
      ...(delaySeconds > 0 ? { delaySeconds } : {}),
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("ads_schedule_triggered", {
    accounts_scanned: accounts.data.length,
    enqueued,
    deduplicated,
  });

  return { accountsScanned: accounts.data.length, enqueued, deduplicated };
}
