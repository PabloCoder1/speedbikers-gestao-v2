import { randomBytes } from "node:crypto";

import type { Database } from "@sb/db";
import { decryptToken } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { createShopeeClient } from "@sb/shopee";
import { describe, expect, it } from "vitest";

import type { Caller } from "./auth.js";
import type { ShopeeShopsDeps } from "./shopee-shops.js";
import { completeShopeeConnect, startShopeeConnect } from "./shopee-shops.js";

const CALLER: Caller = {
  userId: "aaaaaaaa-0000-4000-8000-000000000001",
  organizationId: "11111111-0000-4000-8000-000000000001",
  role: "ADMIN",
};
type ConnectArgs = Database["public"]["Functions"]["shopee_connect_shops"]["Args"];
const ENCRYPTION_KEY = randomBytes(32);
const NOW = new Date("2026-10-13T15:00:00.000Z");
const REDIRECT = "https://api.exemplo.run.app/oauth/shopee/callback";
const ACCESS = "access-token-de-teste-0001";
const REFRESH = "refresh-token-de-teste-0001";

/** Encadeável e `thenable`: só o que `shopee-shops.ts` usa. */
function chain(result: unknown): Record<string, unknown> {
  const self: Record<string, unknown> = {};

  for (const metodo of ["eq", "is", "gt", "select"]) {
    self[metodo] = () => self;
  }

  self.maybeSingle = () => Promise.resolve(result);
  self.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);

  return self;
}

interface Opcoes {
  state?: { data: { organization_id: string; environment: string; created_by: string | null } | null };
  rpcError?: { code: string; message?: string };
  stateInsertFalha?: boolean;
}

function fakeDb(opcoes: Opcoes = {}) {
  const gravado = {
    insert: [] as { table: string; row: Record<string, unknown> }[],
    update: [] as { table: string; row: Record<string, unknown> }[],
    rpc: [] as { name: string; args: ConnectArgs }[],
  };

  const db = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        gravado.insert.push({ table, row });

        return chain(opcoes.stateInsertFalha === true ? { error: { message: "boom" } } : { error: null });
      },
      update: (row: Record<string, unknown>) => {
        gravado.update.push({ table, row });

        return chain({
          data:
            opcoes.state === undefined
              ? { organization_id: CALLER.organizationId, environment: "sandbox", created_by: CALLER.userId }
              : opcoes.state.data,
          error: null,
        });
      },
    }),
    rpc: (name: string, args: ConnectArgs) => {
      gravado.rpc.push({ name, args });

      return Promise.resolve({ data: null, error: opcoes.rpcError ?? null });
    },
  } as unknown as ShopeeShopsDeps["db"];

  return { db, gravado };
}

/** A Shopee falsa: responde por caminho; conta o que foi chamado. */
function fakeShopee(respostas: Record<string, unknown>) {
  const chamadas: { path: string; body: unknown; shopId: string | null }[] = [];
  const fetchImpl = (url: URL, init?: RequestInit) => {
    const corpo: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;

    chamadas.push({ path: url.pathname, body: corpo, shopId: url.searchParams.get("shop_id") });

    const resposta = respostas[url.pathname];

    return Promise.resolve(
      resposta instanceof Error ? Promise.reject(resposta) : new Response(JSON.stringify(resposta), { status: 200 }),
    );
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

const TOKEN = { error: "", message: "", request_id: "r1", access_token: ACCESS, refresh_token: REFRESH, expire_in: 14400 };
const LOJA = {
  error: "",
  request_id: "r2",
  shop_name: "Loja Teste BR",
  region: "BR",
  status: "NORMAL",
  auth_time: 1791900000,
  expire_time: 1823436000,
};

function montar(opcoes: Opcoes & { respostas?: Record<string, unknown> } = {}) {
  const { db, gravado } = fakeDb(opcoes);
  const shopee = fakeShopee(
    opcoes.respostas ?? { "/api/v2/auth/token/get": TOKEN, "/api/v2/shop/get_shop_info": LOJA },
  );
  const lines: string[] = [];
  const deps: ShopeeShopsDeps = {
    db,
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    encryptionKey: ENCRYPTION_KEY,
    client: shopee.client,
    redirectUri: REDIRECT,
    now: () => NOW,
  };

  return { deps, gravado, chamadas: shopee.chamadas, lines };
}

describe("startShopeeConnect (D-425)", () => {
  it("grava o state da organização, no ambiente do cliente, e devolve o link do sandbox", async () => {
    const { deps, gravado } = montar();

    const outcome = await startShopeeConnect(deps, CALLER);

    expect(outcome.status).toBe("redirect");

    const url = new URL(outcome.status === "redirect" ? outcome.authorizationUrl : "http://x");
    const linha = gravado.insert[0]?.row;
    if (linha === undefined) throw new Error("State não gravado");

    expect(url.origin + url.pathname).toBe("https://open.sandbox.test-stable.shopee.com/auth");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe(linha.state);
    expect(linha).toMatchObject({
      organization_id: CALLER.organizationId,
      environment: "sandbox",
      created_by: CALLER.userId,
      expires_at: "2026-10-13T15:15:00.000Z",
    });
    expect(String(linha.state)).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("falha ao gravar o state é recusa, sem link", async () => {
    const { deps } = montar({ stateInsertFalha: true });

    expect(await startShopeeConnect(deps, CALLER)).toEqual({
      status: "rejected",
      reason: "não foi possível iniciar a autorização",
    });
  });
});

describe("completeShopeeConnect (D-425)", () => {
  it("loja única: troca o code, lê a loja e grava loja e tokens cifrados", async () => {
    const { deps, gravado, chamadas, lines } = montar();

    const outcome = await completeShopeeConnect(deps, { state: "s".repeat(43), code: "abc", shopId: 54804 });

    expect(outcome).toEqual({ status: "connected", shops: [{ shopId: 54804, shopName: "Loja Teste BR" }] });
    expect(chamadas.map((c) => c.path)).toEqual(["/api/v2/auth/token/get", "/api/v2/shop/get_shop_info"]);
    expect(chamadas[0]?.body).toEqual({ code: "abc", partner_id: 1248019, shop_id: 54804 });

    expect(gravado.rpc).toHaveLength(1);
    const chamada = gravado.rpc[0];
    expect(chamada).toMatchObject({
      name: "shopee_connect_shops",
      args: {
        p_organization_id: CALLER.organizationId,
        p_environment: "sandbox",
        p_created_by: CALLER.userId,
        p_connected_at: NOW.toISOString(),
        p_shops: [{
          shop_id: 54804,
          shop_name: "Loja Teste BR",
          region: "BR",
          shop_status: "NORMAL",
          authorized_at: new Date(1791900000 * 1000).toISOString(),
          auth_expires_at: new Date(1823436000 * 1000).toISOString(),
        }],
        p_access_token_expires_at: "2026-10-13T19:00:00.000Z",
        p_refresh_token_expires_at: "2026-11-12T15:00:00.000Z",
      },
    });
    if (chamada === undefined) throw new Error("RPC de conexão ausente");
    const { args } = chamada;
    expect(args.p_access_token_ciphertext).not.toContain(ACCESS);
    expect(decryptToken(args.p_access_token_ciphertext, ENCRYPTION_KEY)).toBe(ACCESS);
    expect(decryptToken(args.p_refresh_token_ciphertext, ENCRYPTION_KEY)).toBe(REFRESH);
    // E nenhum token no log.
    expect(lines.join("\n")).not.toContain(ACCESS);
    expect(lines.join("\n")).not.toContain(REFRESH);
  });

  it("conta principal: uma loja por shop_id devolvido, todas com o par inicial", async () => {
    const { deps, gravado, chamadas } = montar({
      respostas: {
        "/api/v2/auth/token/get": { ...TOKEN, shop_id_list: [11, 12] },
        "/api/v2/shop/get_shop_info": LOJA,
      },
    });

    const outcome = await completeShopeeConnect(deps, { state: "s".repeat(43), code: "abc", mainAccountId: 900 });

    expect(outcome.status).toBe("connected");
    expect(chamadas[0]?.body).toEqual({ code: "abc", partner_id: 1248019, main_account_id: 900 });
    expect(chamadas.filter((c) => c.path === "/api/v2/shop/get_shop_info").map((c) => c.shopId)).toEqual(["11", "12"]);
    expect(gravado.rpc).toHaveLength(1);
    expect(gravado.rpc[0]?.args.p_shops).toMatchObject([{ shop_id: 11 }, { shop_id: 12 }]);
  });

  it("state inválido, usado ou vencido: nada é chamado nem gravado", async () => {
    const { deps, gravado, chamadas } = montar({ state: { data: null } });

    expect(await completeShopeeConnect(deps, { state: "x".repeat(43), code: "abc", shopId: 1 })).toEqual({
      status: "invalid_state",
    });
    expect(chamadas).toEqual([]);
    expect(gravado.rpc).toEqual([]);
  });

  it("state do outro ambiente, ou retorno sem code: recusa sem trocar nada", async () => {
    const outroAmbiente = montar({
      state: { data: { organization_id: CALLER.organizationId, environment: "live", created_by: null } },
    });

    expect((await completeShopeeConnect(outroAmbiente.deps, { state: "s".repeat(43), code: "a", shopId: 1 })).status).toBe(
      "rejected",
    );
    expect(outroAmbiente.chamadas).toEqual([]);

    const semCode = montar();

    expect(await completeShopeeConnect(semCode.deps, { state: "s".repeat(43), shopId: 1 })).toEqual({
      status: "rejected",
      reason: "autorização não concluída na Shopee",
    });
    expect(semCode.chamadas).toEqual([]);
  });

  it("a Shopee recusa o code: recusa, sem gravar loja", async () => {
    const { deps, gravado } = montar({
      respostas: { "/api/v2/auth/token/get": { error: "error_param", message: "Invalid code", request_id: "r9" } },
    });

    expect(await completeShopeeConnect(deps, { state: "s".repeat(43), code: "velho", shopId: 1 })).toEqual({
      status: "rejected",
      reason: "não foi possível concluir a autorização com a Shopee",
    });
    expect(gravado.rpc).toEqual([]);
  });

  it("a RPC devolve conflito de organização: recusa a autorização", async () => {
    const { deps, gravado } = montar({ rpcError: { code: "PT409" } });

    expect(await completeShopeeConnect(deps, { state: "s".repeat(43), code: "abc", shopId: 54804 })).toEqual({
      status: "rejected",
      reason: "uma das lojas autorizadas já está ligada a outra organização",
    });
    expect(gravado.rpc).toHaveLength(1);
  });

  it("a leitura da loja falha: conecta sem nome, e a autorização vale desde agora", async () => {
    const { deps, gravado } = montar({
      respostas: {
        "/api/v2/auth/token/get": TOKEN,
        "/api/v2/shop/get_shop_info": { error: "error_server", message: "busy", request_id: "r5" },
      },
    });

    const outcome = await completeShopeeConnect(deps, { state: "s".repeat(43), code: "abc", shopId: 54804 });

    expect(outcome).toEqual({ status: "connected", shops: [{ shopId: 54804, shopName: null }] });
    expect(gravado.rpc[0]?.args.p_shops).toMatchObject([{
      shop_name: null,
      authorized_at: NOW.toISOString(),
      auth_expires_at: null,
    }]);
  });
});
