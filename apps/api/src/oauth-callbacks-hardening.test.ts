import { randomBytes } from "node:crypto";

import { createLogger } from "@sb/observability";
import type { ShopeeClient } from "@sb/shopee";
import type { TikTokShopClient } from "@sb/tiktok-shop";
import { describe, expect, it, vi } from "vitest";

import { completeConnect, type MlAccountsDeps } from "./ml-accounts.js";
import { completeShopeeConnect, type ShopeeShopsDeps } from "./shopee-shops.js";
import { completeTikTokConnect, type TikTokShopsDeps } from "./tiktok-shops.js";

const KEY = randomBytes(32);
const NOW = new Date("2026-11-25T13:00:00.000Z");

function makeLogger() {
  const lines: string[] = [];
  const logger = createLogger({ service: "api-test" }, { sink: (line) => lines.push(line) });

  return { logger, lines };
}

function makeClaimErrorDb(message: string) {
  return {
    from: () => ({
      update: () => ({
        eq: () => ({
          is: () => ({
            gt: () => ({
              select: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: { message } }),
              }),
            }),
          }),
        }),
      }),
    }),
  };
}

describe("OAuth callbacks hardening (D-837)", () => {
  it("ML: erro de banco ao consumir state devolve rejected (não invalid_state) sem vazar erro interno", async () => {
    const { logger, lines } = makeLogger();
    const res = await completeConnect(
      {
        db: makeClaimErrorDb("relation ml_oauth_states timeout") as unknown as MlAccountsDeps["db"],
        logger,
        encryptionKey: KEY,
        enqueuer: { enqueue: vi.fn() },
        oauth: { clientId: "id", clientSecret: "sec", redirectUri: "https://api.test/cb" },
        now: () => NOW,
      },
      { state: "state-valido-1234567890", code: "TG-123" },
    );

    expect(res).toEqual({
      status: "rejected",
      reason: "não foi possível validar a autorização no momento",
    });
    expect(lines.some((line) => line.includes("ml_oauth_state_claim_failed"))).toBe(true);
  });

  it("Shopee: erro de banco ao consumir state devolve rejected (não invalid_state) sem vazar erro interno", async () => {
    const { logger, lines } = makeLogger();
    const res = await completeShopeeConnect(
      {
        db: makeClaimErrorDb("pgbouncer pool exhausted") as unknown as ShopeeShopsDeps["db"],
        logger,
        encryptionKey: KEY,
        client: { environment: "live", partnerId: 123 } as unknown as ShopeeClient,
        redirectUri: "https://api.test/cb",
        now: () => NOW,
      },
      { state: "state-valido-1234567890", code: "code-1", shopId: 99 },
    );

    expect(res).toEqual({
      status: "rejected",
      reason: "não foi possível validar a autorização no momento",
    });
    expect(lines.some((line) => line.includes("shopee_oauth_state_claim_failed"))).toBe(true);
  });

  it("TikTok: erro de banco ao consumir state devolve rejected (não invalid_state) sem vazar erro interno", async () => {
    const { logger, lines } = makeLogger();
    const res = await completeTikTokConnect(
      {
        db: makeClaimErrorDb("connection terminated unexpectedly") as unknown as TikTokShopsDeps["db"],
        logger,
        encryptionKey: KEY,
        client: {} as TikTokShopClient,
        serviceId: "7697150457891358480",
        now: () => NOW,
      },
      { state: "state-valido-1234567890", code: "code-1" },
    );

    expect(res).toEqual({
      status: "rejected",
      reason: "não foi possível validar a autorização no momento",
    });
    expect(lines.some((line) => line.includes("tiktok_oauth_state_claim_failed"))).toBe(true);
  });

  it("Shopee: expire_in fora de faixa de Date devolve rejected sem lançar RangeError", async () => {
    const { logger, lines } = makeLogger();
    const db = {
      from: () => ({
        update: () => ({
          eq: () => ({
            is: () => ({
              gt: () => ({
                select: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: {
                        organization_id: "11111111-0000-4000-8000-000000000001",
                        environment: "live",
                        created_by: "aaaaaaaa-0000-4000-8000-000000000001",
                      },
                      error: null,
                    }),
                }),
              }),
            }),
          }),
        }),
      }),
      rpc: vi.fn(),
    } as unknown as ShopeeShopsDeps["db"];

    const client = {
      environment: "live",
      partnerId: 123,
      request: vi.fn((req: { path: string }) => {
        if (req.path.includes("token/get")) {
          return Promise.resolve({
            access_token: "atk",
            refresh_token: "rtk",
            expire_in: 1e16,
          });
        }

        return Promise.resolve({
          shop_name: "Loja Teste",
          region: "BR",
          status: "NORMAL",
        });
      }),
    } as unknown as ShopeeClient;

    const res = await completeShopeeConnect(
      {
        db,
        logger,
        encryptionKey: KEY,
        client,
        redirectUri: "https://api.test/cb",
        now: () => NOW,
      },
      { state: "state-valido-1234567890", code: "code-1", shopId: 99 },
    );

    expect(res).toEqual({
      status: "rejected",
      reason: "a Shopee devolveu uma validade de credencial inválida",
    });
    expect(lines.some((line) => line.includes("shopee_oauth_invalid_token_expiry"))).toBe(true);
  });
});
