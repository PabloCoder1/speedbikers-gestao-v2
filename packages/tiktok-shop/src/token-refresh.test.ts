import { describe, expect, it, vi } from "vitest";

import {
  TIKTOK_REFRESH_BUFFER_MS,
  isDefinitiveRefreshRefusal,
  refreshTikTokTokenWithLock,
  type TikTokTokenStore,
} from "./auth.js";
import {
  TIKTOK_ERROR_CODES,
  TikTokShopApiError,
  createTikTokShopClient,
  isRateLimitError,
  isScopeMissingError,
  isTokenExpiredError,
  parseRetryAfterMs,
  parseTikTokDecimal,
} from "./client.js";

const NOW = new Date("2026-11-24T12:00:00.000Z");

function makeClient(status: number, body: unknown, headers?: Record<string, string>) {
  return createTikTokShopClient({
    appKey: "chave-teste",
    appSecret: "segredo-teste",
    fetchImpl: vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status, ...(headers ? { headers } : {}) })),
    ),
    now: () => NOW,
  });
}

describe("classificação de erros, Retry-After, decimais e coordenador de refresh (D-807)", () => {
  it("interpreta Retry-After em segundos e data HTTP e classifica códigos oficiais (§5/§11)", () => {
    expect(parseRetryAfterMs("12", NOW)).toBe(12_000);
    expect(parseRetryAfterMs("Tue, 24 Nov 2026 12:00:30 GMT", NOW)).toBe(30_000);
    expect(parseRetryAfterMs("-5", NOW)).toBeNull();
    expect(parseRetryAfterMs("invalido", NOW)).toBeNull();
    expect(parseRetryAfterMs(null, NOW)).toBeNull();

    const rate = new TikTokShopApiError("limite", {
      status: 429,
      code: TIKTOK_ERROR_CODES.RATE_LIMIT,
      requestId: "r1",
      retryAfterMs: 15_000,
    });
    const expired = new TikTokShopApiError("expirado", {
      status: 200,
      code: TIKTOK_ERROR_CODES.TOKEN_EXPIRED,
      requestId: "r2",
    });
    const scope = new TikTokShopApiError("escopo", {
      status: 200,
      code: TIKTOK_ERROR_CODES.SCOPE_MISSING,
      requestId: "r3",
    });
    const revoked = new TikTokShopApiError("revogado", {
      status: 200,
      code: TIKTOK_ERROR_CODES.INVALID_AUTH_CODE,
      requestId: "r4",
    });

    expect(isRateLimitError(rate)).toBe(true);
    expect(rate.retryAfterMs).toBe(15_000);
    expect(isTokenExpiredError(expired)).toBe(true);
    expect(isScopeMissingError(scope)).toBe(true);
    expect(isDefinitiveRefreshRefusal(revoked)).toBe(true);
    // Falhas transitórias e erros de configuração nunca derrubam a loja.
    expect(isDefinitiveRefreshRefusal(rate)).toBe(false);
    expect(isDefinitiveRefreshRefusal(scope)).toBe(false);
    expect(isDefinitiveRefreshRefusal(new Error("ECONNRESET"))).toBe(false);
  });

  it("parseTikTokDecimal rejeita strings vazias/inválidas sem converter ausência em zero", () => {
    expect(parseTikTokDecimal("199.90")).toBe(199.9);
    expect(parseTikTokDecimal(" -12.50 ")).toBe(-12.5);
    expect(parseTikTokDecimal("0.00")).toBe(0);
    expect(parseTikTokDecimal("")).toBeNull();
    expect(parseTikTokDecimal("   ")).toBeNull();
    expect(parseTikTokDecimal(null)).toBeNull();
    expect(parseTikTokDecimal(undefined)).toBeNull();
    expect(parseTikTokDecimal("NaN")).toBeNull();
    expect(parseTikTokDecimal("1e999")).toBeNull();
    expect(parseTikTokDecimal("12.34abc")).toBeNull();
  });

  it("coordenador de refresh reutiliza token válido sem travar", async () => {
    const acquireLock = vi.fn();
    const store: TikTokTokenStore<string> = {
      read: () =>
        Promise.resolve({
          ok: true,
          record: {
            accessToken: "tok-valido",
            refreshToken: "ref-1",
            shopCipher: "ROW_c1",
            accessTokenExpiresAt: new Date(NOW.getTime() + TIKTOK_REFRESH_BUFFER_MS + 60_000),
          },
        }),
      acquireLock,
      releaseLock: vi.fn(),
      saveRefreshed: vi.fn(),
      markRejected: vi.fn(),
    };

    const res = await refreshTikTokTokenWithLock({ client: makeClient(200, { code: 0 }), store, now: NOW });

    expect(res).toEqual({ ok: true, accessToken: "tok-valido", shopCipher: "ROW_c1" });
    expect(acquireLock).not.toHaveBeenCalled();
  });

  it("coordenador solta a trava em try/catch quando outra execução já renovou ou em falha transitória", async () => {
    const releaseLock = vi.fn(() => Promise.reject(new Error("transporte ao soltar")));
    const storeBusyWin: TikTokTokenStore<string> = {
      read: () =>
        Promise.resolve({
          ok: true,
          record: {
            accessToken: "velho",
            refreshToken: "ref-velho",
            shopCipher: "ROW_c1",
            accessTokenExpiresAt: new Date(NOW.getTime() + 1000),
          },
        }),
      acquireLock: () =>
        Promise.resolve({
          ok: true,
          acquired: true,
          handle: "lock-1",
          record: {
            accessToken: "novo-de-outro-worker",
            refreshToken: "ref-novo",
            shopCipher: "ROW_c1",
            accessTokenExpiresAt: new Date(NOW.getTime() + TIKTOK_REFRESH_BUFFER_MS + 60_000),
          },
        }),
      releaseLock,
      saveRefreshed: vi.fn(),
      markRejected: vi.fn(),
    };

    expect(await refreshTikTokTokenWithLock({ client: makeClient(200, { code: 0 }), store: storeBusyWin, now: NOW })).toEqual({
      ok: true,
      accessToken: "novo-de-outro-worker",
      shopCipher: "ROW_c1",
    });
    expect(releaseLock).toHaveBeenCalledWith("lock-1");

    const markRejected = vi.fn();
    const storeTransient: TikTokTokenStore<string> = {
      read: () =>
        Promise.resolve({
          ok: true,
          record: {
            accessToken: "velho",
            refreshToken: "ref-velho",
            shopCipher: "ROW_c1",
            accessTokenExpiresAt: new Date(NOW.getTime() + 1000),
          },
        }),
      acquireLock: () =>
        Promise.resolve({
          ok: true,
          acquired: true,
          handle: "lock-2",
          record: {
            accessToken: "velho",
            refreshToken: "ref-velho",
            shopCipher: "ROW_c1",
            accessTokenExpiresAt: new Date(NOW.getTime() + 1000),
          },
        }),
      releaseLock,
      saveRefreshed: vi.fn(),
      markRejected,
    };

    const falhaTransitoria = await refreshTikTokTokenWithLock({
      client: makeClient(429, { code: 36009002, message: "rate limit" }, { "retry-after": "5" }),
      store: storeTransient,
      now: NOW,
    });

    expect(falhaTransitoria).toMatchObject({ ok: false, retryable: true });
    expect(markRejected).not.toHaveBeenCalled();
  });

  it("marca recusa definitiva no store, persiste renovação válida e protege falha de escrita pós-consumo", async () => {
    const markRejected = vi.fn(() => Promise.resolve({ ok: true as const, applied: true }));
    const baseRecord = {
      accessToken: "velho",
      refreshToken: "ref-velho",
      shopCipher: "ROW_c1",
      accessTokenExpiresAt: new Date(NOW.getTime() + 1000),
    };
    const storeReject: TikTokTokenStore<string> = {
      read: () => Promise.resolve({ ok: true, record: baseRecord }),
      acquireLock: () => Promise.resolve({ ok: true, acquired: true, handle: "lock-3", record: baseRecord }),
      releaseLock: vi.fn(),
      saveRefreshed: vi.fn(),
      markRejected,
    };

    const recusada = await refreshTikTokTokenWithLock({
      client: makeClient(200, { code: 36004004, message: "invalid refresh_token" }),
      store: storeReject,
      now: NOW,
    });

    expect(recusada).toMatchObject({ ok: false, retryable: false });
    expect(markRejected).toHaveBeenCalledWith("lock-3", expect.stringContaining("36004004"));

    const saveRefreshed = vi.fn(() => Promise.resolve({ ok: true as const, applied: true }));
    const storeOk: TikTokTokenStore<string> = {
      ...storeReject,
      saveRefreshed,
    };
    const renewed = await refreshTikTokTokenWithLock({
      client: makeClient(200, {
        code: 0,
        data: {
          access_token: "tok-novo",
          access_token_expire_in: Math.floor(NOW.getTime() / 1000) + 604800,
          refresh_token: "ref-novo",
          refresh_token_expire_in: Math.floor(NOW.getTime() / 1000) + 2592000,
          open_id: "open-1",
          user_type: 0,
        },
      }),
      store: storeOk,
      now: NOW,
    });

    expect(renewed).toEqual({ ok: true, accessToken: "tok-novo", shopCipher: "ROW_c1" });
    expect(saveRefreshed).toHaveBeenCalledWith(
      "lock-3",
      expect.objectContaining({ accessToken: "tok-novo", refreshToken: "ref-novo" }),
    );

    const storeWriteFail: TikTokTokenStore<string> = {
      ...storeReject,
      saveRefreshed: () => Promise.resolve({ ok: false, reason: "disk full" }),
    };
    const writeFail = await refreshTikTokTokenWithLock({
      client: makeClient(200, {
        code: 0,
        data: {
          access_token: "tok-novo",
          access_token_expire_in: Math.floor(NOW.getTime() / 1000) + 604800,
          refresh_token: "ref-novo",
          refresh_token_expire_in: Math.floor(NOW.getTime() / 1000) + 2592000,
          open_id: "open-1",
          user_type: 0,
        },
      }),
      store: storeWriteFail,
      now: NOW,
    });

    expect(writeFail).toMatchObject({ ok: false, retryable: false });
  });
});
