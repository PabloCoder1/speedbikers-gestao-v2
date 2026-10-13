import { randomBytes } from "node:crypto";

import { decryptToken, encryptToken } from "@sb/mercado-livre";
import { createShopeeClient } from "@sb/shopee";
import { describe, expect, it } from "vitest";

import type { ShopeeTokenDeps } from "./shopee-token.js";
import { ensureShopeeAccessToken } from "./shopee-token.js";

const KEY = randomBytes(32);
const NOW = new Date("2026-10-13T15:00:00.000Z");
const LOJA = { id: "loja-1", shopId: 54804 };

interface Credencial {
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  access_token_expires_at: string;
}

function credencial(acesso: string, refresh: string, venceEmMin: number): Credencial {
  return {
    access_token_ciphertext: encryptToken(acesso, KEY),
    refresh_token_ciphertext: encryptToken(refresh, KEY),
    access_token_expires_at: new Date(NOW.getTime() + venceEmMin * 60_000).toISOString(),
  };
}

/** `shopee_credentials` e `shopee_shops`, com a trava devolvendo a linha do momento dela. */
function fakeDb(opcoes: { lida: Credencial | null; travada?: Credencial | null }) {
  const updates: { table: string; row: Record<string, unknown> }[] = [];

  function chain(result: unknown, aoAtualizar?: Record<string, unknown>, table?: string) {
    const self: Record<string, unknown> = {};

    for (const metodo of ["eq", "or", "select"]) {
      self[metodo] = () => self;
    }

    self.maybeSingle = () => Promise.resolve(result);
    self.then = (resolve: (value: unknown) => unknown) => {
      if (aoAtualizar !== undefined && table !== undefined) updates.push({ table, row: aoAtualizar });

      return Promise.resolve({ error: null }).then(resolve);
    };

    return self;
  }

  const db = {
    from: (table: string) => ({
      select: () => chain({ data: opcoes.lida, error: null }),
      update: (row: Record<string, unknown>) => {
        // A trava: o update que devolve a linha (`select().maybeSingle()`).
        if (table === "shopee_credentials" && "refresh_locked_until" in row && row.refresh_locked_until !== null) {
          updates.push({ table, row });

          return chain({ data: opcoes.travada === undefined ? opcoes.lida : opcoes.travada, error: null });
        }

        return chain({ error: null }, row, table);
      },
    }),
  } as unknown as ShopeeTokenDeps["db"];

  return { db, updates };
}

function clienteShopee(resposta: unknown) {
  const chamadas: string[] = [];
  const fetchImpl = (url: URL) => {
    chamadas.push(url.pathname);

    return Promise.resolve(new Response(JSON.stringify(resposta), { status: 200 }));
  };

  return {
    client: createShopeeClient({
      environment: "sandbox",
      partnerId: 1248019,
      partnerKey: "chave-de-teste-nao-real",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    }),
    chamadas,
  };
}

const RENOVADO = { error: "", access_token: "acesso-novo-000001", refresh_token: "refresh-novo-000001", expire_in: 14400 };

describe("ensureShopeeAccessToken (D-426)", () => {
  it("token com folga: devolve sem chamar a Shopee nem travar", async () => {
    const { db, updates } = fakeDb({ lida: credencial("acesso-atual", "refresh-atual", 120) });
    const { client, chamadas } = clienteShopee(RENOVADO);

    expect(await ensureShopeeAccessToken({ db, client, encryptionKey: KEY }, LOJA, NOW)).toEqual({
      ok: true,
      accessToken: "acesso-atual",
    });
    expect(chamadas).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("perto de vencer: trava, renova com o refresh da TRAVA e grava o par novo cifrado", async () => {
    const { db, updates } = fakeDb({
      lida: credencial("acesso-velho", "refresh-da-leitura", 5),
      travada: credencial("acesso-velho", "refresh-da-trava", 5),
    });
    const { client, chamadas } = clienteShopee(RENOVADO);

    const resultado = await ensureShopeeAccessToken({ db, client, encryptionKey: KEY }, LOJA, NOW);

    expect(resultado).toEqual({ ok: true, accessToken: "acesso-novo-000001" });
    expect(chamadas).toEqual(["/api/v2/auth/access_token/get"]);

    const gravado = updates.find((u) => u.table === "shopee_credentials" && u.row.refresh_locked_until === null)?.row;

    expect(decryptToken(String(gravado?.refresh_token_ciphertext), KEY)).toBe("refresh-novo-000001");
    expect(gravado).toMatchObject({
      access_token_expires_at: "2026-10-13T19:00:00.000Z",
      refresh_token_expires_at: "2026-11-12T15:00:00.000Z",
    });
  });

  it("trava ocupada: falha passageira, sem chamar a Shopee", async () => {
    const { db } = fakeDb({ lida: credencial("a", "r", 5), travada: null });
    const { client, chamadas } = clienteShopee(RENOVADO);

    expect(await ensureShopeeAccessToken({ db, client, encryptionKey: KEY }, LOJA, NOW)).toMatchObject({
      ok: false,
      retryable: true,
    });
    expect(chamadas).toEqual([]);
  });

  it("outra execução renovou entre a leitura e a trava: usa o token dela, sem gastar o refresh", async () => {
    const { db } = fakeDb({ lida: credencial("a", "r", 5), travada: credencial("ja-renovado", "r2", 230) });
    const { client, chamadas } = clienteShopee(RENOVADO);

    expect(await ensureShopeeAccessToken({ db, client, encryptionKey: KEY }, LOJA, NOW)).toEqual({
      ok: true,
      accessToken: "ja-renovado",
    });
    expect(chamadas).toEqual([]);
  });

  it("recusa definitiva: a loja vai para ERROR e não há nova tentativa", async () => {
    const { db, updates } = fakeDb({ lida: credencial("a", "r", 5) });
    const { client } = clienteShopee({ error: "refresh_token_expired", message: "Your refresh_token expired." });

    expect(await ensureShopeeAccessToken({ db, client, encryptionKey: KEY }, LOJA, NOW)).toMatchObject({
      ok: false,
      retryable: false,
    });
    expect(updates.find((u) => u.table === "shopee_shops")?.row).toMatchObject({ status: "ERROR" });
  });

  it("erro de servidor da Shopee: passageiro, e a loja continua conectada", async () => {
    const { db, updates } = fakeDb({ lida: credencial("a", "r", 5) });
    const { client } = clienteShopee({ error: "error_server", message: "Something wrong." });

    expect(await ensureShopeeAccessToken({ db, client, encryptionKey: KEY }, LOJA, NOW)).toMatchObject({
      ok: false,
      retryable: true,
    });
    expect(updates.some((u) => u.table === "shopee_shops")).toBe(false);
  });

  it("loja sem credencial: precisa conectar de novo", async () => {
    const { db } = fakeDb({ lida: null });
    const { client } = clienteShopee(RENOVADO);

    expect(await ensureShopeeAccessToken({ db, client, encryptionKey: KEY }, LOJA, NOW)).toMatchObject({
      ok: false,
      retryable: false,
    });
  });
});
