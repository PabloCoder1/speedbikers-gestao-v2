import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import type { TikTokShopClient } from "@sb/tiktok-shop";
import { describe, expect, it, vi } from "vitest";

import { ensureTikTokAccessToken, type TikTokTokenDeps } from "./tiktok-token.js";

const KEY = randomBytes(32);
const SHOP_ID = "33333333-0000-4000-8000-000000000003";
const NOW = new Date("2026-11-25T12:00:00.000Z");

describe("ensureTikTokAccessToken (D-833)", () => {
  it("devolve o token cifrado sem chamar refresh quando ainda está válido fora da folga", async () => {
    const row = {
      shop_cipher: "TTP_CIPHER_1",
      access_token_ciphertext: encryptToken("atk_valid", KEY),
      refresh_token_ciphertext: encryptToken("rtk_valid", KEY),
      access_token_expires_at: "2026-11-26T12:00:00.000Z",
    };

    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: row, error: null }),
          }),
        }),
      }),
    } as unknown as TikTokTokenDeps["db"];

    const request = vi.fn();
    const res = await ensureTikTokAccessToken(
      { db, client: { request } as unknown as TikTokShopClient, encryptionKey: KEY },
      SHOP_ID,
      NOW,
    );

    expect(res).toEqual({
      ok: true,
      accessToken: "atk_valid",
      shopCipher: "TTP_CIPHER_1",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("falha fechado (retryable=false) sem vazar detalhes criptográficos quando o ciphertext está corrompido", async () => {
    const row = {
      shop_cipher: "TTP_CIPHER_1",
      access_token_ciphertext: "ciphertext-corrompido-sem-formato-aes-gcm-valido",
      refresh_token_ciphertext: encryptToken("rtk_valid", KEY),
      access_token_expires_at: "2026-11-26T12:00:00.000Z",
    };

    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: row, error: null }),
          }),
        }),
      }),
    } as unknown as TikTokTokenDeps["db"];

    const res = await ensureTikTokAccessToken(
      { db, client: {} as unknown as TikTokShopClient, encryptionKey: KEY },
      SHOP_ID,
      NOW,
    );

    expect(res).toEqual({
      ok: false,
      retryable: false,
      reason: "credencial cifrada do TikTok Shop inválida ou corrompida",
    });
  });

  it("solta a trava quando a leitura pós-acquire encontra ciphertext corrompido", async () => {
    const expiredRow = {
      shop_cipher: "TTP_CIPHER_1",
      access_token_ciphertext: encryptToken("atk_old", KEY),
      refresh_token_ciphertext: encryptToken("rtk_old", KEY),
      access_token_expires_at: "2026-11-25T11:50:00.000Z",
    };
    const corruptedRow = {
      shop_cipher: "TTP_CIPHER_1",
      access_token_ciphertext: "not-valid-ciphertext-at-all-12345678901234567890",
      refresh_token_ciphertext: "not-valid-ciphertext-at-all-12345678901234567890",
      access_token_expires_at: "2026-11-25T11:50:00.000Z",
    };

    const releaseCalled = vi.fn();
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: expiredRow, error: null }),
          }),
        }),
        update: (values: Record<string, unknown>) => {
          if (values.refresh_locked_until === null) {
            releaseCalled();

            return {
              eq: () => ({
                eq: () => Promise.resolve({ error: null }),
              }),
            };
          }

          return {
            eq: () => ({
              or: () => ({
                select: () => ({
                  maybeSingle: () => Promise.resolve({ data: corruptedRow, error: null }),
                }),
              }),
            }),
          };
        },
      }),
    } as unknown as TikTokTokenDeps["db"];

    const res = await ensureTikTokAccessToken(
      { db, client: {} as unknown as TikTokShopClient, encryptionKey: KEY },
      SHOP_ID,
      NOW,
    );

    expect(res).toEqual({
      ok: false,
      retryable: false,
      reason: "credencial cifrada do TikTok Shop inválida ou corrompida",
    });
    expect(releaseCalled).toHaveBeenCalledTimes(1);
  });

  it("trata erro transitório do banco ao ler credenciais como retryable=true", async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: { message: "timeout" } }),
          }),
        }),
      }),
    } as unknown as TikTokTokenDeps["db"];

    const res = await ensureTikTokAccessToken(
      { db, client: {} as unknown as TikTokShopClient, encryptionKey: KEY },
      SHOP_ID,
      NOW,
    );

    expect(res).toEqual({
      ok: false,
      retryable: true,
      reason: "falha ao ler a credencial do TikTok Shop: timeout",
    });
  });
});
