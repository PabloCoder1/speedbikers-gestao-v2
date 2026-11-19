import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import { createBackfillOrdersHandler } from "./backfill-orders.js";
import { createSyncAdsCampaignsHandler } from "./sync-ads-campaigns.js";
import { createSyncFulfillmentSnapshotHandler } from "./sync-fulfillment-snapshot.js";
import { createSyncListingVisitsSnapshotHandler } from "./sync-listing-visits-snapshot.js";
import { createSyncListingsSnapshotHandler } from "./sync-listings-snapshot.js";
import { createSyncOrdersWindowHandler } from "./sync-orders-window.js";
import { createSyncSupportClaimsReconcileHandler } from "./sync-support-claims-reconcile.js";
import { createSyncSupportMessagesReconcileHandler } from "./sync-support-messages-reconcile.js";
import { createSyncSupportQuestionsReconcileHandler } from "./sync-support-questions-reconcile.js";
import { createWebhookReceivedHandler } from "./webhook-received.js";

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";

const ENVELOPE = {
  jobType: "test.ml.account",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
  organizationId: ORGANIZATION_ID,
  dedupeKey: "test-ml-account-read",
  attempt: 1,
  enqueuedAt: "2026-08-22T15:37:00.000Z",
};

function fakeAccountDb(result: { data: null; error: { message: string } | null }) {
  const self = {
    select: () => self,
    eq: () => self,
    maybeSingle: () => Promise.resolve(result),
    then: <R>(resolve: (value: typeof result) => R) => Promise.resolve(result).then(resolve),
  };

  return {
    from: () => self,
  };
}

const CASES = [
  {
    name: "webhook-received",
    create: (db: ReturnType<typeof fakeAccountDb>) =>
      createWebhookReceivedHandler({ db } as unknown as Parameters<typeof createWebhookReceivedHandler>[0]),
    payload: { mlAccountId: ML_ACCOUNT_ID, resource: "/orders/2000003508426396", topic: "orders_v2" },
    missingLog: "webhook_fast_path_account_missing",
  },
  {
    name: "backfill-orders",
    create: (db: ReturnType<typeof fakeAccountDb>) =>
      createBackfillOrdersHandler({ db } as unknown as Parameters<typeof createBackfillOrdersHandler>[0]),
    payload: { mlAccountId: ML_ACCOUNT_ID },
    missingLog: "backfill_orders_account_missing",
  },
  {
    name: "sync-orders-window",
    create: (db: ReturnType<typeof fakeAccountDb>) =>
      createSyncOrdersWindowHandler({ db } as unknown as Parameters<typeof createSyncOrdersWindowHandler>[0]),
    payload: { mlAccountId: ML_ACCOUNT_ID },
    missingLog: "sync_orders_window_account_missing",
  },
  {
    name: "sync-ads-campaigns",
    create: (db: ReturnType<typeof fakeAccountDb>) =>
      createSyncAdsCampaignsHandler({ db } as unknown as Parameters<typeof createSyncAdsCampaignsHandler>[0]),
    payload: { mlAccountId: ML_ACCOUNT_ID },
    missingLog: "sync_ads_campaigns_account_missing",
  },
  {
    name: "sync-fulfillment-snapshot",
    create: (db: ReturnType<typeof fakeAccountDb>) =>
      createSyncFulfillmentSnapshotHandler({ db } as unknown as Parameters<typeof createSyncFulfillmentSnapshotHandler>[0]),
    payload: { mlAccountId: ML_ACCOUNT_ID },
    missingLog: "sync_fulfillment_snapshot_account_missing",
  },
  {
    name: "sync-listings-snapshot",
    create: (db: ReturnType<typeof fakeAccountDb>) =>
      createSyncListingsSnapshotHandler({ db } as unknown as Parameters<typeof createSyncListingsSnapshotHandler>[0]),
    payload: { mlAccountId: ML_ACCOUNT_ID },
    missingLog: "sync_listings_snapshot_account_missing",
  },
  {
    name: "sync-listing-visits-snapshot",
    create: (db: ReturnType<typeof fakeAccountDb>) =>
      createSyncListingVisitsSnapshotHandler({ db } as unknown as Parameters<typeof createSyncListingVisitsSnapshotHandler>[0]),
    payload: { mlAccountId: ML_ACCOUNT_ID },
    missingLog: "sync_listing_visits_snapshot_account_missing",
  },
  {
    name: "sync-support-claims-reconcile",
    create: (db: ReturnType<typeof fakeAccountDb>) =>
      createSyncSupportClaimsReconcileHandler({ db } as unknown as Parameters<typeof createSyncSupportClaimsReconcileHandler>[0]),
    payload: { mlAccountId: ML_ACCOUNT_ID },
    missingLog: "sync_support_claims_reconcile_account_missing",
  },
  {
    name: "sync-support-messages-reconcile",
    create: (db: ReturnType<typeof fakeAccountDb>) =>
      createSyncSupportMessagesReconcileHandler({ db } as unknown as Parameters<typeof createSyncSupportMessagesReconcileHandler>[0]),
    payload: { mlAccountId: ML_ACCOUNT_ID },
    missingLog: "sync_support_messages_reconcile_account_missing",
  },
  {
    name: "sync-support-questions-reconcile",
    create: (db: ReturnType<typeof fakeAccountDb>) =>
      createSyncSupportQuestionsReconcileHandler({ db } as unknown as Parameters<typeof createSyncSupportQuestionsReconcileHandler>[0]),
    payload: { mlAccountId: ML_ACCOUNT_ID },
    missingLog: "sync_support_questions_reconcile_account_missing",
  },
] as const;

describe("handlers ML distinguem erro transitório do banco de conta ausente", () => {
  for (const item of CASES) {
    it(`${item.name}: falha do banco ao ler ml_accounts marca retryable=true em vez de descartar`, async () => {
      const lines: string[] = [];
      const logger = createLogger({}, { sink: (line) => lines.push(line) });
      const handler = item.create(fakeAccountDb({ data: null, error: { message: "connection timeout" } }));

      const outcome = await handler(ENVELOPE, { logger, payload: item.payload });

      expect(outcome).toEqual({
        status: "failed",
        retryable: true,
        reason: "falha ao ler conta Mercado Livre: connection timeout",
      });
      expect(lines.join()).not.toContain(item.missingLog);
    });

    it(`${item.name}: conta ausente sem erro encerra sem retry e registra ${item.missingLog}`, async () => {
      const lines: string[] = [];
      const logger = createLogger({}, { sink: (line) => lines.push(line) });
      const handler = item.create(fakeAccountDb({ data: null, error: null }));

      const outcome = await handler(ENVELOPE, { logger, payload: item.payload });

      expect(outcome).toEqual({ status: "done", processed: 0 });
      expect(lines.join()).toContain(item.missingLog);
    });
  }
});
