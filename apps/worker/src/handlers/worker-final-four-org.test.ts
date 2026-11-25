import { randomBytes } from "node:crypto";

import type { JobEnvelope } from "@sb/contracts";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import type { ShopeeClient } from "@sb/shopee";
import { describe, expect, it, vi } from "vitest";

import type { Enqueuer } from "../enqueue.js";
import { createErpImportApplyHandler } from "./erp-import-apply.js";
import { createShopeeOrdersSyncHandler } from "./shopee-orders-sync.js";
import { createSyncCentralAlertsHandler } from "./sync-central-alerts.js";
import { createSyncListingsSnapshotHandler } from "./sync-listings-snapshot.js";

const ORG_A = "11111111-0000-4000-8000-000000000001";
const ORG_B = "22222222-0000-4000-8000-000000000002";
const ENTITY_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-25T12:00:00.000Z");

function makeEnvelope(jobType: string, organizationId = ORG_A): JobEnvelope {
  return {
    jobType,
    jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b99",
    organizationId,
    dedupeKey: `${jobType}:${ENTITY_ID}`,
    attempt: 1,
    enqueuedAt: NOW.toISOString(),
  };
}

const silentLogger = () => createLogger({}, { sink: () => undefined });

describe("isolamento multi-tenant nos 4 handlers finais sob service_role (D-832)", () => {
  it("erp-import-apply recusa lote de outra organização com retryable=false", async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: {
                  id: ENTITY_ID,
                  kind: "PRODUCTS",
                  status: "APPLYING",
                  organization_id: ORG_B,
                  parsed_at: NOW.toISOString(),
                  file_name: "erp.xlsx",
                },
                error: null,
              }),
          }),
        }),
      }),
    } as unknown as Parameters<typeof createErpImportApplyHandler>[0]["db"];

    const handler = createErpImportApplyHandler({ db });
    const outcome = await handler(makeEnvelope("erp.import.apply"), {
      payload: { batchId: ENTITY_ID },
      logger: silentLogger(),
    });

    expect(outcome).toEqual({
      status: "failed",
      retryable: false,
      reason: "lote pertence a outra organização",
    });
  });

  it("shopee-orders-sync propaga envelope.organizationId e recusa loja de outra organização", async () => {
    const rpc = vi.fn();
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: {
                  id: ENTITY_ID,
                  organization_id: ORG_B,
                  environment: "live",
                  shop_id: 12345,
                  status: "CONNECTED",
                  orders_synced_until: null,
                },
                error: null,
              }),
          }),
        }),
      }),
      rpc,
    } as unknown as Parameters<typeof createShopeeOrdersSyncHandler>[0]["db"];

    const handler = createShopeeOrdersSyncHandler({
      db,
      client: { environment: "live" } as unknown as ShopeeClient,
      encryptionKey: randomBytes(32),
      enqueuer: { enqueue: vi.fn<Enqueuer["enqueue"]>() },
      now: () => NOW,
    });

    const outcome = await handler(makeEnvelope("shopee.orders.sync"), {
      payload: { shopeeShopId: ENTITY_ID },
      logger: silentLogger(),
    });

    expect(outcome).toEqual({
      status: "failed",
      retryable: false,
      reason: "loja da Shopee pertence a outra organização",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sync-central-alerts recusa organizationId do payload divergente do envelope antes de chamar RPC", async () => {
    const rpc = vi.fn();
    const db = { rpc } as unknown as Parameters<typeof createSyncCentralAlertsHandler>[0]["db"];

    const handler = createSyncCentralAlertsHandler({ db });
    const outcome = await handler(makeEnvelope("maintenance.sync-central-alerts", ORG_A), {
      payload: { organizationId: ORG_B },
      logger: silentLogger(),
    });

    expect(outcome).toEqual({
      status: "failed",
      retryable: false,
      reason: "organizationId do payload diverge do envelope",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sync-listings-snapshot recusa conta de outra organização com retryable=false", async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: {
                  id: ENTITY_ID,
                  organization_id: ORG_B,
                  status: "CONNECTED",
                  seller_id: 999,
                },
                error: null,
              }),
          }),
        }),
      }),
    } as unknown as Parameters<typeof createSyncListingsSnapshotHandler>[0]["db"];

    const handler = createSyncListingsSnapshotHandler({
      db,
      mercadoLivre: {} as unknown as MercadoLivreClient,
      oauth: { clientId: "id", clientSecret: "secret", redirectUri: "" },
      encryptionKey: randomBytes(32),
      now: () => NOW,
    });

    const outcome = await handler(makeEnvelope("sync.listings.snapshot"), {
      payload: { mlAccountId: ENTITY_ID },
      logger: silentLogger(),
    });

    expect(outcome).toEqual({
      status: "failed",
      retryable: false,
      reason: "conta do Mercado Livre pertence a outra organização",
    });
  });

  it("sync-listings-snapshot devolve retryable=true em erro transitório ao ler ml_accounts (não silencia como done)", async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: null,
                error: { message: "connection reset" },
              }),
          }),
        }),
      }),
    } as unknown as Parameters<typeof createSyncListingsSnapshotHandler>[0]["db"];

    const handler = createSyncListingsSnapshotHandler({
      db,
      mercadoLivre: {} as unknown as MercadoLivreClient,
      oauth: { clientId: "id", clientSecret: "secret", redirectUri: "" },
      encryptionKey: randomBytes(32),
      now: () => NOW,
    });

    const outcome = await handler(makeEnvelope("sync.listings.snapshot"), {
      payload: { mlAccountId: ENTITY_ID },
      logger: silentLogger(),
    });

    expect(outcome).toEqual({
      status: "failed",
      retryable: true,
      reason: "falha ao ler conta Mercado Livre: connection reset",
    });
  });
});
