import { encryptToken } from "@sb/mercado-livre";
import { createTikTokShopClient } from "@sb/tiktok-shop";
import { describe, expect, it, vi } from "vitest";

import { ensureTikTokShopAccessToken, type TikTokTokenStoreDeps } from "./tiktok-token-store.js";

const KEY = Buffer.alloc(32, 7);
const NOW = new Date("2026-11-24T14:00:00.000Z");
const SHOP_UUID = "cccccccc-0000-4000-8000-0000000000c1";

interface FakeCredentialRow {
  shop_cipher: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  access_token_expires_at: string;
  refresh_token_expires_at: string;
  refresh_locked_until: string | null;
}

function makeDb(initial: FakeCredentialRow | null, options: { lockBusy?: boolean; saveFails?: boolean } = {}) {
  let row = initial === null ? null : { ...initial };
  const shopUpdates: Record<string, unknown>[] = [];

  const db = {
    from: (table: string) => {
      if (table === "tiktok_shops") {
        return {
          update: (values: Record<string, unknown>) => ({
            eq: () => {
              shopUpdates.push(values);

              return Promise.resolve({ error: null });
            },
          }),
        };
      }

      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: row === null ? null : { ...row }, error: null }),
          }),
        }),
        update: (values: Record<string, unknown>) => {
          const filters: Record<string, unknown> = {};
          const finish = () => {
            if (row === null) return Promise.resolve({ data: null, error: null });

            if ("refresh_locked_until" in values && values.refresh_locked_until !== null && options.lockBusy === true) {
              return Promise.resolve({ data: null, error: null });
            }

            if (
              "access_token_ciphertext" in values &&
              options.saveFails === true
            ) {
              return Promise.resolve({ data: null, error: { message: "write timeout" } });
            }

            if (
              filters.refresh_locked_until !== undefined &&
              row.refresh_locked_until !== filters.refresh_locked_until
            ) {
              return Promise.resolve({ data: null, error: null });
            }

            if (
              filters.refresh_token_ciphertext !== undefined &&
              row.refresh_token_ciphertext !== filters.refresh_token_ciphertext
            ) {
              return Promise.resolve({ data: null, error: null });
            }

            row = { ...row, ...(values as Partial<FakeCredentialRow>) };

            return Promise.resolve({ data: { ...row, tiktok_shop_id: SHOP_UUID }, error: null });
          };

          const chain = {
            eq: (col: string, val: unknown) => {
              filters[col] = val;

              return chain;
            },
            or: () => chain,
            select: () => ({ maybeSingle: finish }),
            then: (resolve: (val: { data: unknown; error: { message: string } | null }) => void) => finish().then(resolve),
          };

          return chain;
        },
      };
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === "tiktok_reject_token_refresh") {
        if (
          row === null ||
          row.refresh_locked_until !== args.p_locked_until ||
          row.refresh_token_ciphertext !== args.p_previous_refresh_ciphertext
        ) {
          return Promise.resolve({ data: false, error: null });
        }

        row = { ...row, refresh_locked_until: null };
        shopUpdates.push({ status: "ERROR", last_error: args.p_error });

        return Promise.resolve({ data: true, error: null });
      }

      return Promise.resolve({ data: null, error: { message: `rpc não simulada: ${name}` } });
    },
  } as unknown as TikTokTokenStoreDeps["db"];

  return { db, getRow: () => row, shopUpdates };
}

function makeClient(status: number, body: unknown) {
  return createTikTokShopClient({
    appKey: "chave-teste",
    appSecret: "segredo-teste",
    fetchImpl: vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))),
    now: () => NOW,
  });
}

describe("ensureTikTokShopAccessToken — adaptador Supabase (D-810)", () => {
  it("devolve token cifrado válido sem adquirir trava nem chamar a API do TikTok", async () => {
    const fetchSpy = vi.fn();
    const { db } = makeDb({
      shop_cipher: "ROW_cipher_1",
      access_token_ciphertext: encryptToken("tok-ativo", KEY),
      refresh_token_ciphertext: encryptToken("ref-ativo", KEY),
      access_token_expires_at: new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
      refresh_token_expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
      refresh_locked_until: null,
    });
    const client = createTikTokShopClient({
      appKey: "chave",
      appSecret: "segredo",
      fetchImpl: fetchSpy,
      now: () => NOW,
    });

    const res = await ensureTikTokShopAccessToken({ db, client, encryptionKey: KEY, tiktokShopId: SHOP_UUID, now: NOW });

    expect(res).toEqual({ ok: true, accessToken: "tok-ativo", shopCipher: "ROW_cipher_1" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renova token próximo do vencimento com CAS, grava novo par cifrado e libera a trava", async () => {
    const { db, getRow } = makeDb({
      shop_cipher: "ROW_cipher_1",
      access_token_ciphertext: encryptToken("tok-velho", KEY),
      refresh_token_ciphertext: encryptToken("ref-velho", KEY),
      access_token_expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
      refresh_token_expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
      refresh_locked_until: null,
    });
    const nextExp = Math.floor(NOW.getTime() / 1000) + 604_800;
    const nextRefExp = Math.floor(NOW.getTime() / 1000) + 2_592_000;
    const client = makeClient(200, {
      code: 0,
      data: {
        access_token: "tok-novo",
        access_token_expire_in: nextExp,
        refresh_token: "ref-novo",
        refresh_token_expire_in: nextRefExp,
        open_id: "open-1",
        user_type: 0,
      },
    });

    const res = await ensureTikTokShopAccessToken({ db, client, encryptionKey: KEY, tiktokShopId: SHOP_UUID, now: NOW });

    expect(res).toEqual({ ok: true, accessToken: "tok-novo", shopCipher: "ROW_cipher_1" });
    expect(getRow()?.refresh_locked_until).toBeNull();
    expect(getRow()?.access_token_expires_at).toBe(new Date(nextExp * 1000).toISOString());
  });

  it("recusa definitiva (36004004) marca tiktok_shops como ERROR e libera trava; 429 mantém loja conectada", async () => {
    const baseRow: FakeCredentialRow = {
      shop_cipher: "ROW_cipher_1",
      access_token_ciphertext: encryptToken("tok-velho", KEY),
      refresh_token_ciphertext: encryptToken("ref-velho", KEY),
      access_token_expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
      refresh_token_expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
      refresh_locked_until: null,
    };

    const rate = makeDb(baseRow);
    const resRate = await ensureTikTokShopAccessToken({
      db: rate.db,
      client: makeClient(429, { code: 36009002, message: "rate limit" }),
      encryptionKey: KEY,
      tiktokShopId: SHOP_UUID,
      now: NOW,
    });

    expect(resRate).toMatchObject({ ok: false, retryable: true });
    expect(rate.shopUpdates).toEqual([]);
    expect(rate.getRow()?.refresh_locked_until).toBeNull();

    const revoked = makeDb(baseRow);
    const resRevoked = await ensureTikTokShopAccessToken({
      db: revoked.db,
      client: makeClient(200, { code: 36004004, message: "invalid refresh" }),
      encryptionKey: KEY,
      tiktokShopId: SHOP_UUID,
      now: NOW,
    });

    expect(resRevoked).toMatchObject({ ok: false, retryable: false });
    expect(revoked.shopUpdates).toHaveLength(1);
    expect(revoked.shopUpdates[0]?.status).toBe("ERROR");
    expect(String(revoked.shopUpdates[0]?.last_error)).toContain("36004004");
    expect(revoked.getRow()?.refresh_locked_until).toBeNull();
  });

  it("falha fechada sem vazar erro de cifra quando ciphertext está corrompido e retenta quando trava está ocupada", async () => {
    const corrompida = makeDb({
      shop_cipher: "ROW_cipher_1",
      access_token_ciphertext: "ciphertext-corrompido-invalido-01234567890123456789",
      refresh_token_ciphertext: encryptToken("ref", KEY),
      access_token_expires_at: new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
      refresh_token_expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
      refresh_locked_until: null,
    });

    const resCorrompida = await ensureTikTokShopAccessToken({
      db: corrompida.db,
      client: makeClient(200, { code: 0 }),
      encryptionKey: KEY,
      tiktokShopId: SHOP_UUID,
      now: NOW,
    });

    expect(resCorrompida).toMatchObject({ ok: false, retryable: false });

    const ocupada = makeDb(
      {
        shop_cipher: "ROW_cipher_1",
        access_token_ciphertext: encryptToken("tok-velho", KEY),
        refresh_token_ciphertext: encryptToken("ref-velho", KEY),
        access_token_expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
        refresh_token_expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
        refresh_locked_until: null,
      },
      { lockBusy: true },
    );

    const resOcupada = await ensureTikTokShopAccessToken({
      db: ocupada.db,
      client: makeClient(200, { code: 0 }),
      encryptionKey: KEY,
      tiktokShopId: SHOP_UUID,
      now: NOW,
    });

    expect(resOcupada).toMatchObject({ ok: false, retryable: true });
  });

  it("não marca loja como ERROR se reconexão OAuth trocou refresh_token_ciphertext durante recusa do refresh", async () => {
    const { db, shopUpdates } = makeDb({
      shop_cipher: "ROW_cipher_1",
      access_token_ciphertext: encryptToken("tok-velho", KEY),
      refresh_token_ciphertext: encryptToken("ref-velho", KEY),
      access_token_expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
      refresh_token_expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
      refresh_locked_until: null,
    });

    const store = (await import("./tiktok-token-store.js")).createSupabaseTikTokTokenStore({
      db,
      encryptionKey: KEY,
      tiktokShopId: SHOP_UUID,
    });

    const lock = await store.acquireLock(new Date(NOW.getTime() + 60_000), NOW);

    expect(lock.ok && lock.acquired).toBe(true);
    if (!lock.ok || !lock.acquired) return;

    // Simula reconexão OAuth concorrente gravando novo refresh_token_ciphertext
    // (preservando a janela de tempo sem alterar o handle antigo).
    const rejected = await store.markRejected(
      { ...lock.handle, previousRefreshCiphertext: encryptToken("ref-outro", KEY) },
      "refresh_token expirado",
    );

    expect(rejected).toEqual({ ok: true, applied: false });
    expect(shopUpdates).toHaveLength(0);
  });
});
