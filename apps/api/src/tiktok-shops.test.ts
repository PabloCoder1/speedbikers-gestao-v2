import { randomBytes } from "node:crypto";

import { decryptToken } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { createTikTokShopClient } from "@sb/tiktok-shop";
import { describe, expect, it } from "vitest";

import type { Caller } from "./auth.js";
import type { TikTokShopsDeps } from "./tiktok-shops.js";
import { completeTikTokConnect, startTikTokConnect } from "./tiktok-shops.js";

const CALLER: Caller = {
  userId: "aaaaaaaa-0000-4000-8000-000000000001",
  organizationId: "11111111-0000-4000-8000-000000000001",
  role: "ADMIN",
};
const OUTRA_ORG = "22222222-0000-4000-8000-000000000002";
const ENCRYPTION_KEY = randomBytes(32);
const NOW = new Date("2026-10-22T15:00:00.000Z");
const SERVICE_ID = "7697150457891358480";
const ACCESS = "TTP_access-token-de-teste";
const REFRESH = "TTP_refresh-token-de-teste";
const APP_SECRET = "segredo-de-teste-nao-real";

/** Encadeável e `thenable`: só o que `tiktok-shops.ts` usa. */
function chain(result: unknown): Record<string, unknown> {
  const self: Record<string, unknown> = {};

  for (const metodo of ["eq", "is", "gt", "in", "select"]) {
    self[metodo] = () => self;
  }

  self.maybeSingle = () => Promise.resolve(result);
  self.single = () => Promise.resolve(result);
  self.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);

  return self;
}

interface Opcoes {
  state?: { data: { organization_id: string; created_by: string | null } | null };
  existentes?: { shop_id: string; organization_id: string }[];
  stateInsertFalha?: boolean;
}

function fakeDb(opcoes: Opcoes = {}) {
  const gravado: Record<string, { table: string; row: Record<string, unknown> }[]> = { insert: [], update: [], upsert: [] };
  let proximoId = 1;

  const db = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        gravado.insert?.push({ table, row });

        return chain(opcoes.stateInsertFalha === true ? { error: { message: "boom" } } : { error: null });
      },
      update: (row: Record<string, unknown>) => {
        gravado.update?.push({ table, row });

        return chain({
          data: opcoes.state === undefined ? { organization_id: CALLER.organizationId, created_by: CALLER.userId } : opcoes.state.data,
          error: null,
        });
      },
      select: () => chain({ data: opcoes.existentes ?? [], error: null }),
      upsert: (row: Record<string, unknown>) => {
        gravado.upsert?.push({ table, row });

        return chain({ data: { id: `loja-${String(proximoId++)}` }, error: null });
      },
    }),
  } as unknown as TikTokShopsDeps["db"];

  return { db, gravado };
}

/** O TikTok falso: responde por caminho; guarda o que foi chamado. */
function fakeTikTok(respostas: Record<string, unknown>) {
  const chamadas: URL[] = [];
  const fetchImpl = (url: URL) => {
    chamadas.push(url);

    const resposta = respostas[url.pathname];

    return Promise.resolve(new Response(JSON.stringify(resposta ?? { code: 40000, message: "nao simulado" }), { status: 200 }));
  };

  return {
    client: createTikTokShopClient({
      appKey: "chave-de-teste",
      appSecret: APP_SECRET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    }),
    chamadas,
  };
}

const TOKEN = {
  code: 0,
  message: "success",
  request_id: "r1",
  data: {
    access_token: ACCESS,
    access_token_expire_in: 1793286000,
    refresh_token: REFRESH,
    refresh_token_expire_in: 1824222000,
    open_id: "7010736057180325637",
    seller_name: "Speed Bikers",
    seller_base_region: "BR",
    user_type: 0,
    granted_scopes: ["seller.order.info", "seller.finance.info"],
  },
};
const LOJAS = {
  code: 0,
  message: "Success",
  data: { shops: [{ id: "7000714532876273420", name: "Speed Bikers BR", region: "BR", seller_type: "LOCAL", cipher: "GCP_cipher_br", code: "BRLC1" }] },
};

function montar(opcoes: Opcoes & { respostas?: Record<string, unknown> } = {}) {
  const { db, gravado } = fakeDb(opcoes);
  const tiktok = fakeTikTok(opcoes.respostas ?? { "/api/v2/token/get": TOKEN, "/authorization/202309/shops": LOJAS });
  const lines: string[] = [];
  const deps: TikTokShopsDeps = {
    db,
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    encryptionKey: ENCRYPTION_KEY,
    client: tiktok.client,
    serviceId: SERVICE_ID,
    now: () => NOW,
  };

  return { deps, gravado, chamadas: tiktok.chamadas, lines };
}

describe("startTikTokConnect (D-645)", () => {
  it("grava o state da organização, válido por 15 minutos, e devolve o link com o service_id e o state", async () => {
    const { deps, gravado } = montar();

    const outcome = await startTikTokConnect(deps, CALLER);

    expect(outcome.status).toBe("redirect");

    const url = new URL(outcome.status === "redirect" ? outcome.authorizationUrl : "http://x");
    const linha = gravado.insert?.[0]?.row ?? {};

    expect(url.origin + url.pathname).toBe("https://services.tiktokshop.com/open/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ service_id: SERVICE_ID, state: linha.state });
    expect(linha).toMatchObject({
      organization_id: CALLER.organizationId,
      created_by: CALLER.userId,
      expires_at: "2026-10-22T15:15:00.000Z",
    });
    expect(String(linha.state).length).toBeGreaterThanOrEqual(40);
  });

  it("falha ao gravar o state: recusa sem link", async () => {
    const { deps } = montar({ stateInsertFalha: true });

    expect(await startTikTokConnect(deps, CALLER)).toEqual({ status: "rejected", reason: "não foi possível iniciar a autorização" });
  });
});

describe("completeTikTokConnect (D-645)", () => {
  it("troca o code, lê as lojas e grava a loja e as credenciais cifradas com o cipher", async () => {
    const { deps, gravado, chamadas } = montar();

    const outcome = await completeTikTokConnect(deps, { state: "s", code: "TTP_code" });

    expect(outcome).toEqual({ status: "connected", shops: [{ shopId: "7000714532876273420", shopName: "Speed Bikers BR" }] });
    expect(chamadas.map((url) => url.pathname)).toEqual(["/api/v2/token/get", "/authorization/202309/shops"]);
    expect(chamadas[0]?.searchParams.get("grant_type")).toBe("authorized_code");

    const loja = gravado.upsert?.find((g) => g.table === "tiktok_shops")?.row;
    const credencial = gravado.upsert?.find((g) => g.table === "tiktok_credentials")?.row ?? {};

    expect(loja).toMatchObject({
      organization_id: CALLER.organizationId,
      shop_id: "7000714532876273420",
      shop_name: "Speed Bikers BR",
      seller_type: "LOCAL",
      shop_code: "BRLC1",
      open_id: "7010736057180325637",
      granted_scopes: ["seller.order.info", "seller.finance.info"],
      status: "CONNECTED",
      auth_expires_at: new Date(1824222000 * 1000).toISOString(),
      created_by: CALLER.userId,
    });
    expect(credencial).toMatchObject({
      tiktok_shop_id: "loja-1",
      shop_cipher: "GCP_cipher_br",
      access_token_expires_at: new Date(1793286000 * 1000).toISOString(),
    });
    // Cifrado de verdade: nunca o texto claro, e decifra para o token.
    expect(credencial.access_token_ciphertext).not.toContain(ACCESS);
    expect(decryptToken(String(credencial.access_token_ciphertext), ENCRYPTION_KEY)).toBe(ACCESS);
    expect(decryptToken(String(credencial.refresh_token_ciphertext), ENCRYPTION_KEY)).toBe(REFRESH);
  });

  it("state inválido, vencido ou já usado: nada é chamado nem gravado", async () => {
    const { deps, gravado, chamadas } = montar({ state: { data: null } });

    expect(await completeTikTokConnect(deps, { state: "s", code: "TTP_code" })).toEqual({ status: "invalid_state" });
    expect(chamadas).toHaveLength(0);
    expect(gravado.upsert).toHaveLength(0);
  });

  it("a recusa do vendedor (auth_denied) ou o retorno sem code consomem o state e recusam, sem trocar token", async () => {
    const recusa = montar();
    const semCode = montar();
    const erroComCode = montar();

    expect(await completeTikTokConnect(recusa.deps, { state: "s", error: "auth_denied" })).toMatchObject({ status: "rejected" });
    expect(await completeTikTokConnect(semCode.deps, { state: "s" })).toMatchObject({ status: "rejected" });
    // O erro vence o code: nunca se troca token de um retorno que diz erro.
    expect(await completeTikTokConnect(erroComCode.deps, { state: "s", code: "TTP_code", error: "auth_denied" })).toMatchObject({
      status: "rejected",
    });
    expect(recusa.gravado.update).toHaveLength(1);
    expect(recusa.chamadas).toHaveLength(0);
    expect(semCode.chamadas).toHaveLength(0);
    expect(erroComCode.chamadas).toHaveLength(0);
  });

  it("a troca recusada pelo TikTok não grava nada, e o log não leva o App Secret", async () => {
    const { deps, gravado, lines } = montar({
      respostas: { "/api/v2/token/get": { code: 36004004, message: "invalid auth_code" } },
    });

    expect(await completeTikTokConnect(deps, { state: "s", code: "velho" })).toEqual({
      status: "rejected",
      reason: "não foi possível concluir a autorização com o TikTok Shop",
    });
    expect(gravado.upsert).toHaveLength(0);
    expect(lines.join("\n")).toContain("tiktok_oauth_exchange_failed");
    expect(lines.join("\n")).not.toContain(APP_SECRET);
  });

  it("a autorização que não é de vendedor é recusada antes de ler as lojas", async () => {
    const { deps, chamadas } = montar({
      respostas: { "/api/v2/token/get": { ...TOKEN, data: { ...TOKEN.data, user_type: 1 } }, "/authorization/202309/shops": LOJAS },
    });

    expect(await completeTikTokConnect(deps, { state: "s", code: "TTP_code" })).toEqual({
      status: "rejected",
      reason: "a autorização não veio de uma conta de vendedor",
    });
    expect(chamadas.map((url) => url.pathname)).toEqual(["/api/v2/token/get"]);
  });

  it("sem loja autorizada, ou com a loja de outra organização, nada é gravado", async () => {
    const vazio = montar({ respostas: { "/api/v2/token/get": TOKEN, "/authorization/202309/shops": { code: 0, data: { shops: [] } } } });
    const deOutra = montar({ existentes: [{ shop_id: "7000714532876273420", organization_id: OUTRA_ORG }] });

    expect(await completeTikTokConnect(vazio.deps, { state: "s", code: "TTP_code" })).toEqual({
      status: "rejected",
      reason: "o TikTok Shop não devolveu nenhuma loja autorizada",
    });
    expect(await completeTikTokConnect(deOutra.deps, { state: "s", code: "TTP_code" })).toEqual({
      status: "rejected",
      reason: "uma das lojas autorizadas já está ligada a outra organização",
    });
    expect(vazio.gravado.upsert).toHaveLength(0);
    expect(deOutra.gravado.upsert).toHaveLength(0);
  });
});
