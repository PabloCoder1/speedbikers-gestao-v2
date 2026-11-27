import { randomBytes } from "node:crypto";

import { decryptToken, encryptToken } from "@sb/mercado-livre";
import { createShopeeClient } from "@sb/shopee";
import { describe, expect, it } from "vitest";

import type { ShopeeTokenDeps } from "./shopee-token.js";
import { ensureShopeeAccessToken } from "./shopee-token.js";

const KEY = randomBytes(32);
const NOW = new Date("2026-10-13T15:00:00.000Z");
const LOJA = { id: "loja-1", shopId: 54804 };
const ATE = "2026-10-13T15:01:00.000Z";

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
function fakeDb(opcoes: {
  lida: Credencial | null;
  travada?: Credencial | null;
  erroNaTrava?: { message: string };
  lancaAoSoltar?: boolean;
  travaPerdida?: boolean;
}) {
  const updates: { table: string; row: Record<string, unknown>; filtros: Record<string, unknown> }[] = [];
  const recusas: { name: string; args: Record<string, unknown> }[] = [];

  function chain(result: unknown, aoAtualizar?: Record<string, unknown>, table?: string) {
    const self: Record<string, unknown> = {};

    for (const metodo of ["or", "select"]) {
      self[metodo] = () => self;
    }

    const filtros: Record<string, unknown> = {};
    self.eq = (coluna: string, valor: unknown) => {
      filtros[coluna] = valor;

      return self;
    };
    const executar = () => {
      if (aoAtualizar !== undefined && table !== undefined) {
        updates.push({ table, row: aoAtualizar, filtros });
        if (opcoes.travaPerdida === true && typeof filtros.refresh_lock_id === "string") {
          return Promise.resolve({ data: null, error: null });
        }
      }

      return Promise.resolve(result);
    };
    self.maybeSingle = executar;
    self.then = (resolve: (value: unknown) => unknown) => executar().then(resolve);

    return self;
  }

  const db = {
    from: (table: string) => ({
      select: () => chain({ data: opcoes.lida, error: null }),
      update: (row: Record<string, unknown>) => {
        // A trava: o update que devolve a linha (`select().maybeSingle()`).
        if (table === "shopee_credentials" && "refresh_locked_until" in row && row.refresh_locked_until !== null) {
          if (opcoes.erroNaTrava !== undefined) {
            return chain({ data: null, error: opcoes.erroNaTrava }, row, table);
          }

          return chain({ data: opcoes.travada === undefined ? opcoes.lida : opcoes.travada, error: null }, row, table);
        }

        if (table === "shopee_credentials" && row.refresh_locked_until === null && opcoes.lancaAoSoltar === true) {
          const self: Record<string, unknown> = {};
          self.eq = () => self;
          self.then = (_resolve: unknown, reject: (err: Error) => unknown) =>
            Promise.reject(new Error("socket hang up ao soltar trava")).then(undefined, reject);

          return self;
        }

        return chain({ data: { shopee_shop_id: LOJA.id }, error: null }, row, table);
      },
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      recusas.push({ name, args });

      return Promise.resolve({ data: opcoes.travaPerdida !== true || typeof args.p_lock_id !== "string", error: null });
    },
  } as unknown as ShopeeTokenDeps["db"];

  return { db, updates, recusas };
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
    const { db, updates, recusas } = fakeDb({ lida: credencial("a", "r", 5) });
    const { client } = clienteShopee({ error: "refresh_token_expired", message: "Your refresh_token expired." });

    expect(await ensureShopeeAccessToken({ db, client, encryptionKey: KEY }, LOJA, NOW)).toMatchObject({
      ok: false,
      retryable: false,
    });
    expect(recusas).toMatchObject([{ name: "shopee_reject_token_refresh", args: {
      p_shopee_shop_id: LOJA.id,
      p_lock_id: updates[0]?.row.refresh_lock_id,
    } }]);
  });

  it("descarta o sucesso antigo mesmo quando a nova trava tem o mesmo prazo", async () => {
    const { db, updates } = fakeDb({ lida: credencial("a", "r", 5), travaPerdida: true });
    const { client } = clienteShopee(RENOVADO);

    expect(await ensureShopeeAccessToken({ db, client, encryptionKey: KEY }, LOJA, NOW)).toMatchObject({
      ok: false,
      retryable: true,
    });
    expect(updates[0]?.row.refresh_locked_until).toBe(ATE);
    expect(updates[0]?.row.refresh_lock_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(updates[1]?.filtros).toEqual({ shopee_shop_id: LOJA.id, refresh_lock_id: updates[0]?.row.refresh_lock_id });
  });

  it("uma recusa antiga preserva o status e a nova trava com o mesmo prazo", async () => {
    const { db, updates, recusas } = fakeDb({ lida: credencial("a", "r", 5), travaPerdida: true });
    const { client } = clienteShopee({ error: "refresh_token_expired", message: "Your refresh_token expired." });

    expect(await ensureShopeeAccessToken({ db, client, encryptionKey: KEY }, LOJA, NOW)).toMatchObject({
      ok: false,
      retryable: true,
    });
    expect(updates).toHaveLength(1);
    expect(recusas[0]?.args.p_lock_id).toBe(updates[0]?.row.refresh_lock_id);
  });

  it("erro de servidor da Shopee: passageiro, e a loja continua conectada", async () => {
    const { db, updates, recusas } = fakeDb({ lida: credencial("a", "r", 5) });
    const { client } = clienteShopee({ error: "error_server", message: "Something wrong." });

    expect(await ensureShopeeAccessToken({ db, client, encryptionKey: KEY }, LOJA, NOW)).toMatchObject({
      ok: false,
      retryable: true,
    });
    expect(updates.some((u) => u.table === "shopee_shops")).toBe(false);
    expect(updates[1]?.filtros).toEqual({ shopee_shop_id: LOJA.id, refresh_lock_id: updates[0]?.row.refresh_lock_id });
    expect(recusas).toHaveLength(0);
  });

  it("loja sem credencial: precisa conectar de novo", async () => {
    const { db } = fakeDb({ lida: null });
    const { client } = clienteShopee(RENOVADO);

    expect(await ensureShopeeAccessToken({ db, client, encryptionKey: KEY }, LOJA, NOW)).toMatchObject({
      ok: false,
      retryable: false,
    });
  });

  it("D-780: erro do banco ao reservar a trava reporta o motivo explícito em vez de corrida", async () => {
    const { db } = fakeDb({ lida: credencial("a", "r", 5), erroNaTrava: { message: "statement timeout" } });
    const { client } = clienteShopee(RENOVADO);

    expect(await ensureShopeeAccessToken({ db, client, encryptionKey: KEY }, LOJA, NOW)).toEqual({
      ok: false,
      retryable: true,
      reason: "falha ao reservar a trava de renovação da loja: statement timeout",
    });
  });

  it("D-780: falha de transporte ao soltar a trava não descarta token já renovado nem mascara erro transitório da Shopee", async () => {
    const { db: dbJaRenovado } = fakeDb({
      lida: credencial("a", "r", 5),
      travada: credencial("ja-renovado", "r2", 230),
      lancaAoSoltar: true,
    });
    expect(await ensureShopeeAccessToken({ db: dbJaRenovado, client: clienteShopee(RENOVADO).client, encryptionKey: KEY }, LOJA, NOW)).toEqual({
      ok: true,
      accessToken: "ja-renovado",
    });

    const { db: dbErro } = fakeDb({ lida: credencial("a", "r", 5), lancaAoSoltar: true });
    const { client: clientErro } = clienteShopee({ error: "error_server", message: "Something wrong." });
    expect(await ensureShopeeAccessToken({ db: dbErro, client: clientErro, encryptionKey: KEY }, LOJA, NOW)).toMatchObject({
      ok: false,
      retryable: true,
    });
  });

  it("D-831: ciphertext corrompido ou chave incompatível falha fechado (retryable=false) e solta a trava", async () => {
    const { client, chamadas } = clienteShopee(RENOVADO);

    // Caminho 1: access_token válido mas corrompido na leitura inicial
    const { db: db1 } = fakeDb({
      lida: {
        access_token_ciphertext: "ciphertext-corrompido",
        refresh_token_ciphertext: "ciphertext-corrompido",
        access_token_expires_at: new Date(NOW.getTime() + 2 * 3600_000).toISOString(),
      },
    });
    await expect(ensureShopeeAccessToken({ db: db1, client, encryptionKey: KEY }, LOJA, NOW)).resolves.toMatchObject({
      ok: false,
      retryable: false,
    });

    // Caminho 2: access_token renovado por outra execução mas corrompido na trava
    const { db: db2, updates: updates2 } = fakeDb({
      lida: credencial("a", "r", 5),
      travada: {
        access_token_ciphertext: "ciphertext-corrompido",
        refresh_token_ciphertext: "ciphertext-corrompido",
        access_token_expires_at: new Date(NOW.getTime() + 2 * 3600_000).toISOString(),
      },
    });
    await expect(ensureShopeeAccessToken({ db: db2, client, encryptionKey: KEY }, LOJA, NOW)).resolves.toMatchObject({
      ok: false,
      retryable: false,
    });
    expect(updates2.at(-1)?.row).toEqual({ refresh_locked_until: null, refresh_lock_id: null });

    // Caminho 3: refresh_token corrompido na trava — solta trava e não chama Shopee
    const { db: db3, updates: updates3 } = fakeDb({
      lida: credencial("a", "r", 5),
      travada: {
        access_token_ciphertext: "ciphertext-corrompido",
        refresh_token_ciphertext: "ciphertext-corrompido",
        access_token_expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
      },
    });
    await expect(ensureShopeeAccessToken({ db: db3, client, encryptionKey: KEY }, LOJA, NOW)).resolves.toMatchObject({
      ok: false,
      retryable: false,
    });
    expect(chamadas).toHaveLength(0);
    expect(updates3.at(-1)?.row).toEqual({ refresh_locked_until: null, refresh_lock_id: null });
  });
});
