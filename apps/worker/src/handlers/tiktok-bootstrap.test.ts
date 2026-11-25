import { randomBytes } from "node:crypto";

import { TIKTOK_JOB_TYPE_LIST } from "@sb/contracts";
import type { AdminClient } from "@sb/db";
import { describe, expect, it, vi } from "vitest";

import type { Enqueuer } from "../enqueue.js";
import { createTikTokWorkerHandlers } from "./tiktok-bootstrap.js";
import type { TikTokSyncRepository } from "./tiktok-repository.js";

const KEY = randomBytes(32);

function fakeRepo(): TikTokSyncRepository {
  return {
    acquireOrdersLock: vi.fn(),
    releaseOrdersLock: vi.fn(),
    readOrdersCursor: vi.fn(),
    advanceOrdersCursor: vi.fn(),
    upsertOrders: vi.fn(),
    upsertCatalogUnits: vi.fn(),
    upsertReturns: vi.fn(),
    upsertOrderFinancials: vi.fn(),
    upsertStatements: vi.fn(),
  };
}

describe("createTikTokWorkerHandlers (D-835)", () => {
  it("retorna mapa vazio quando credenciais TikTok ou repositório estão ausentes", () => {
    const db = {} as AdminClient;
    const enqueuer: Enqueuer = { enqueue: vi.fn() };

    expect(
      createTikTokWorkerHandlers({
        env: { TIKTOK_SHOP_APP_KEY: undefined, TIKTOK_SHOP_APP_SECRET: undefined },
        db,
        enqueuer,
        encryptionKey: KEY,
        repository: fakeRepo(),
      }),
    ).toEqual({});

    expect(
      createTikTokWorkerHandlers({
        env: { TIKTOK_SHOP_APP_KEY: "app_key_123", TIKTOK_SHOP_APP_SECRET: "secret_1234567890abcdef" },
        db,
        enqueuer,
        encryptionKey: KEY,
      }),
    ).toEqual({});
  });

  it("registra exatamente os 5 job types de TIKTOK_JOB_TYPE_LIST quando configurado", () => {
    const handlers = createTikTokWorkerHandlers({
      env: { TIKTOK_SHOP_APP_KEY: "app_key_123", TIKTOK_SHOP_APP_SECRET: "secret_1234567890abcdef" },
      db: {} as AdminClient,
      enqueuer: { enqueue: vi.fn() },
      encryptionKey: KEY,
      repository: fakeRepo(),
    });

    expect(Object.keys(handlers).sort()).toEqual([...TIKTOK_JOB_TYPE_LIST].sort());
  });
});
