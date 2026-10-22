import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { buildAuthorizationUrl, getAccessToken, refreshAccessToken, tiktokEpochToIso } from "./auth.js";
import { TikTokShopApiError, createTikTokShopClient } from "./client.js";
import { getAuthorizedShops } from "./shops.js";
import { sign, signBaseString } from "./sign.js";

const NOW = new Date("2026-10-22T15:00:00.000Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));
const APP_SECRET = "segredo-de-teste-nao-real";

/** O endereço chamado, sem a query. */
const endereco = (url: URL | undefined): string => (url === undefined ? "" : `${url.origin}${url.pathname}`);

function clienteCom(status: number, corpo: unknown) {
  const chamadas: { url: URL; init: RequestInit | undefined }[] = [];
  const fetchImpl = vi.fn((url: URL, init?: RequestInit) => {
    chamadas.push({ url, init });

    return Promise.resolve(new Response(JSON.stringify(corpo), { status }));
  });
  const client = createTikTokShopClient({
    appKey: "chave-de-teste",
    appSecret: APP_SECRET,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW,
  });

  return { client, chamadas };
}

describe("assinatura (P`sign-your-api-request`)", () => {
  it("o exemplo oficial: Get Authorized Shops com app_secret e59af819cc", () => {
    const query = { app_key: "29a39d", timestamp: "1623812664" };

    expect(signBaseString("/authorization/202309/shops", query)).toBe("/authorization/202309/shopsapp_key29a39dtimestamp1623812664");
    expect(sign("e59af819cc", "/authorization/202309/shops", query)).toBe(
      "b596b73e0cc6de07ac26f036364178ab16b0a907af13d43f0a0cd2345f582dc8",
    );
  });

  it("o exemplo oficial com corpo: o shop_cipher entra, e o corpo vai no fim, nos bytes enviados", () => {
    const corpo = '{"address":"https://partner.tiktokshop.com","event_type":"PACKAGE_UPDATE"}';

    expect(
      signBaseString("/event/202309/webhooks", { timestamp: "1696909648", shop_cipher: "ROW_xkMbgAAAeVAQra0eZWebFQq5aIK", app_key: "68xu9ks5p4i8" }, corpo),
    ).toBe(`/event/202309/webhooksapp_key68xu9ks5p4i8shop_cipherROW_xkMbgAAAeVAQra0eZWebFQq5aIKtimestamp1696909648${corpo}`);
  });

  it("sign e access_token ficam fora, mesmo se vierem na query", () => {
    expect(signBaseString("/x", { access_token: "tok", sign: "abc", app_key: "k" })).toBe("/xapp_keyk");
  });
});

describe("o cliente", () => {
  it("chamada de loja: app_key, timestamp, shop_cipher e sign na query; o token no cabeçalho; devolve o data", async () => {
    const { client, chamadas } = clienteCom(200, { code: 0, message: "Success", request_id: "r1", data: { ok: true } });

    const data = await client.request({
      method: "POST",
      path: "/order/202309/orders/search",
      accessToken: "token-do-vendedor",
      shopCipher: "GCP_cipher",
      query: { page_size: "50" },
      body: { order_status: "COMPLETED" },
      schema: z.object({ ok: z.boolean() }),
    });

    const chamada = chamadas[0];
    const query = Object.fromEntries(chamada?.url.searchParams ?? []);
    const { sign: assinatura, ...semSign } = query;

    expect(data).toEqual({ ok: true });
    expect(endereco(chamada?.url)).toBe("https://open-api.tiktokglobalshop.com/order/202309/orders/search");
    expect(semSign).toEqual({ page_size: "50", app_key: "chave-de-teste", timestamp: TIMESTAMP, shop_cipher: "GCP_cipher" });
    // A assinatura e a do corpo EXATO que foi enviado.
    expect(assinatura).toBe(sign(APP_SECRET, "/order/202309/orders/search", semSign, chamada?.init?.body as string));
    expect(chamada?.init?.headers).toMatchObject({ "x-tts-access-token": "token-do-vendedor", "content-type": "application/json" });
    expect(query).not.toHaveProperty("access_token");
  });

  it("code diferente de 0 é erro, mesmo com HTTP 200; o limite e o interno são passageiros", async () => {
    const limite = clienteCom(429, { code: 36009002, message: "rate limit" });
    const interno = clienteCom(200, { code: 36009003, message: "internal" });
    const escopo = clienteCom(200, { code: 105005, message: "scope", request_id: "r2" });
    const chamar = (client: ReturnType<typeof clienteCom>["client"]) =>
      client.request({ method: "GET", path: "/authorization/202309/shops", schema: z.unknown() });

    await expect(chamar(limite.client)).rejects.toMatchObject({ errorClass: "retryable", code: 36009002, status: 429 });
    await expect(chamar(interno.client)).rejects.toMatchObject({ errorClass: "retryable", code: 36009003 });
    await expect(chamar(escopo.client)).rejects.toMatchObject({ errorClass: "not_retryable", code: 105005, requestId: "r2" });
  });

  it("HTTP 5xx sem corpo legível é passageiro, e a mensagem nunca leva a URL nem o segredo", async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response("x", { status: 502 }));
    const client = createTikTokShopClient({ appKey: "k", appSecret: APP_SECRET, fetchImpl });

    const erro = await client.request({ method: "GET", path: "/authorization/202309/shops", schema: z.unknown() }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(TikTokShopApiError);
    expect(erro).toMatchObject({ errorClass: "retryable", code: null, status: 502 });
    expect((erro as Error).message).toBe("TikTok Shop respondeu 502 para GET /authorization/202309/shops.");
  });
});

describe("a autorização (P`authorization-overview-202407`)", () => {
  it("o link do vendedor leva só service_id e state, sem app_key", () => {
    const url = new URL(buildAuthorizationUrl({ serviceId: "7697150457891358480", state: "estado-xyz" }));

    expect(url.origin + url.pathname).toBe("https://services.tiktokshop.com/open/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ service_id: "7697150457891358480", state: "estado-xyz" });
  });

  it("o token sai do host de token com grant_type=authorized_code; o erro não leva o app_secret", async () => {
    const dados = {
      access_token: "TTP_a",
      access_token_expire_in: 1660556783,
      refresh_token: "TTP_r",
      refresh_token_expire_in: 1691487031,
      open_id: "7010736057180325637",
      seller_name: "Test Seller",
      seller_base_region: "BR",
      user_type: 0,
      granted_scopes: ["seller.order.info"],
    };
    const ok = clienteCom(200, { code: 0, message: "success", request_id: "r", data: dados });

    expect(await getAccessToken(ok.client, "TTP_code")).toEqual(dados);
    expect(endereco(ok.chamadas[0]?.url)).toBe("https://auth.tiktok-shops.com/api/v2/token/get");
    expect(Object.fromEntries(ok.chamadas[0]?.url.searchParams ?? [])).toEqual({
      app_key: "chave-de-teste",
      app_secret: APP_SECRET,
      auth_code: "TTP_code",
      grant_type: "authorized_code",
    });

    const recusa = clienteCom(200, { code: 36004004, message: "invalid auth_code" });
    const erro = await getAccessToken(recusa.client, "velho").catch((e: unknown) => e);

    expect(erro).toMatchObject({ code: 36004004, errorClass: "not_retryable" });
    expect((erro as Error).message).not.toContain(APP_SECRET);
    expect((erro as Error).message).toContain("GET /api/v2/token/get");
  });

  it("a renovação usa grant_type=refresh_token, e o instante Unix vira ISO", async () => {
    const { client, chamadas } = clienteCom(200, {
      code: 0,
      data: {
        access_token: "a", access_token_expire_in: 1, refresh_token: "r", refresh_token_expire_in: 2, open_id: "o", user_type: 0,
      },
    });

    await refreshAccessToken(client, "TTP_r");

    expect(chamadas[0]?.url.pathname).toBe("/api/v2/token/refresh");
    expect(chamadas[0]?.url.searchParams.get("grant_type")).toBe("refresh_token");
    expect(tiktokEpochToIso(1660556783)).toBe("2022-08-15T09:46:23.000Z");
  });
});

describe("as lojas autorizadas (P`get-authorized-shops-202309`)", () => {
  it("lê id, nome, região, tipo, cipher e código; o token vai no cabeçalho", async () => {
    const { client, chamadas } = clienteCom(200, {
      code: 0,
      message: "Success",
      data: {
        shops: [{ id: "7000714532876273420", name: "Loja SB", region: "BR", seller_type: "LOCAL", cipher: "GCP_XF90", code: "BRLCS1" }],
      },
    });

    expect(await getAuthorizedShops(client, "token")).toEqual([
      { id: "7000714532876273420", name: "Loja SB", region: "BR", seller_type: "LOCAL", cipher: "GCP_XF90", code: "BRLCS1" },
    ]);
    expect(chamadas[0]?.url.pathname).toBe("/authorization/202309/shops");
    expect(chamadas[0]?.init?.headers).toMatchObject({ "x-tts-access-token": "token" });
  });
});
