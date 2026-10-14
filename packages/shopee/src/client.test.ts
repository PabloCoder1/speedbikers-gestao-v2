import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { buildAuthorizationUrl, getAccessToken, refreshAccessToken } from "./auth.js";
import { ShopeeApiError, createShopeeClient, isShopLevelError, sign, signBaseString } from "./client.js";
import { getShopInfo, shopeeEpochToIso } from "./shop.js";

const NOW = new Date("2026-10-13T15:00:00.000Z");
const TIMESTAMP = Math.floor(NOW.getTime() / 1000);
const PARTNER_KEY = "chave-de-teste-nao-real";

function clienteCom(status: number, corpo: unknown) {
  const chamadas: { url: URL; init: RequestInit | undefined }[] = [];
  const fetchImpl = vi.fn((url: URL, init?: RequestInit) => {
    chamadas.push({ url, init });

    return Promise.resolve(new Response(JSON.stringify(corpo), { status }));
  });
  const client = createShopeeClient({
    environment: "sandbox",
    partnerId: 1248019,
    partnerKey: PARTNER_KEY,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW,
  });

  return { client, chamadas };
}

/** O corpo JSON que o cliente mandou. */
function corpoDe(init: RequestInit | undefined): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : null;
}

describe("assinatura (open.shopee.com/developer-guide/16)", () => {
  it("monta a base na ordem da documentação — os três exemplos dela", () => {
    expect(
      signBaseString(2001887, "/api/v2/shop/get_shop_info", 1655714431, {
        accessToken: "59777174636562737266615546704c6d",
        shopId: 14701711,
      }),
    ).toBe("2001887/api/v2/shop/get_shop_info165571443159777174636562737266615546704c6d14701711");
    expect(signBaseString(2001887, "/api/v2/public/get_shops_by_partner", 1655714431)).toBe(
      "2001887/api/v2/public/get_shops_by_partner1655714431",
    );
  });

  it("é HMAC-SHA256 da base com a Partner Key, em hexadecimal minúsculo", () => {
    const base = "2001887/api/v2/auth/token/get1655714431";

    expect(sign(PARTNER_KEY, base)).toBe(createHmac("sha256", PARTNER_KEY).update(base).digest("hex"));
    expect(sign(PARTNER_KEY, base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("cliente", () => {
  it("chamada de loja: partner_id, timestamp, access_token, shop_id e a assinatura de loja na query", async () => {
    const { client, chamadas } = clienteCom(200, { error: "", message: "", request_id: "r1", shop_name: "Loja" });

    await getShopInfo(client, { accessToken: "tok-acesso", shopId: 54804 });

    const url = chamadas[0]?.url;

    expect(`${url?.origin ?? ""}${url?.pathname ?? ""}`).toBe(
      "https://openplatform.sandbox.test-stable.shopee.sg/api/v2/shop/get_shop_info",
    );
    expect(Object.fromEntries(url?.searchParams.entries() ?? [])).toEqual({
      partner_id: "1248019",
      timestamp: String(TIMESTAMP),
      access_token: "tok-acesso",
      shop_id: "54804",
      sign: sign(PARTNER_KEY, `1248019/api/v2/shop/get_shop_info${String(TIMESTAMP)}tok-acesso54804`),
    });
  });

  it("erro de negócio com HTTP 200 vira ShopeeApiError, sem token nem assinatura na mensagem", async () => {
    const { client } = clienteCom(200, { error: "error_auth", message: "Invalid access_token.", request_id: "r2" });

    const falha = await getShopInfo(client, { accessToken: "tok-secreto", shopId: 1 }).catch((e: unknown) => e);

    expect(falha).toBeInstanceOf(ShopeeApiError);
    expect(falha).toMatchObject({ status: 200, code: "error_auth", requestId: "r2", errorClass: "not_retryable" });
    expect((falha as Error).message).not.toContain("tok-secreto");
    expect((falha as Error).message).not.toContain("sign");
  });

  it("5xx é repetível; o corpo fora do contrato no sucesso é erro de schema", async () => {
    const { client } = clienteCom(503, null);
    const falha = await client
      .request({ method: "GET", path: "/api/v2/x", schema: z.object({}) })
      .catch((e: unknown) => e);

    expect(falha).toMatchObject({ status: 503, code: null, errorClass: "retryable" });

    const outro = clienteCom(200, { error: "", access_token: 7 });

    await expect(getAccessToken(outro.client, { code: "c", shopId: 1 })).rejects.toThrow();
  });
});

describe("autorização (open.shopee.com/developer-guide/20)", () => {
  it("o link do sandbox (pagina global), sem assinatura, com o state", () => {
    const url = new URL(
      buildAuthorizationUrl({
        environment: "sandbox",
        partnerId: 1248019,
        redirectUri: "https://api.exemplo.run.app/oauth/shopee/callback",
        state: "estado-aleatorio-de-teste",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://open.sandbox.test-stable.shopee.com/auth");
    expect(Object.fromEntries(url.searchParams.entries())).toEqual({
      partner_id: "1248019",
      auth_type: "seller",
      redirect_uri: "https://api.exemplo.run.app/oauth/shopee/callback",
      response_type: "code",
      state: "estado-aleatorio-de-teste",
    });
  });

  it("troca o code por shop_id ou main_account_id, com a assinatura pública", async () => {
    const resposta = { error: "", message: "", request_id: "r3", access_token: "a", refresh_token: "r", expire_in: 14400 };
    const loja = clienteCom(200, resposta);

    await getAccessToken(loja.client, { code: "abc", shopId: 54804 });

    expect(corpoDe(loja.chamadas[0]?.init)).toEqual({ code: "abc", partner_id: 1248019, shop_id: 54804 });
    expect(loja.chamadas[0]?.url.searchParams.get("sign")).toBe(
      sign(PARTNER_KEY, `1248019/api/v2/auth/token/get${String(TIMESTAMP)}`),
    );
    expect(loja.chamadas[0]?.url.searchParams.has("access_token")).toBe(false);

    const principal = clienteCom(200, { ...resposta, shop_id_list: [11, 12] });
    const token = await getAccessToken(principal.client, { code: "abc", mainAccountId: 900 });

    expect(corpoDe(principal.chamadas[0]?.init)).toEqual({
      code: "abc",
      partner_id: 1248019,
      main_account_id: 900,
    });
    expect(token.shop_id_list).toEqual([11, 12]);
  });

  it("renova pela loja, mandando o refresh_token no corpo", async () => {
    const { client, chamadas } = clienteCom(200, {
      error: "",
      access_token: "a2",
      refresh_token: "r2",
      expire_in: 14400,
      shop_id: 54804,
    });

    const token = await refreshAccessToken(client, { refreshToken: "r1", shopId: 54804 });

    expect(chamadas[0]?.url.pathname).toBe("/api/v2/auth/access_token/get");
    expect(corpoDe(chamadas[0]?.init)).toEqual({ refresh_token: "r1", partner_id: 1248019, shop_id: 54804 });
    expect(token.refresh_token).toBe("r2");
  });
});

describe("datas da Shopee", () => {
  it("epoch em segundos vira ISO; zero e ausente viram nulo, nunca 1970", () => {
    expect(shopeeEpochToIso(1642069441)).toBe("2022-01-13T10:24:01.000Z");
    expect(shopeeEpochToIso(0)).toBeNull();
    expect(shopeeEpochToIso(null)).toBeNull();
  });
});

describe("classificação dos erros da Shopee (D-428)", () => {
  const erro = (code: string | null, status = 200) => new ShopeeApiError("x", { status, code, requestId: null });

  it("o código com prefixo de módulo vira o código-base", () => {
    expect(erro("product.error_item_not_found").baseCode).toBe("error_item_not_found");
    expect(erro("error_param").baseCode).toBe("error_param");
    expect(erro(null).baseCode).toBeNull();
  });

  it("os códigos de 'tente depois' das páginas do catálogo são passageiros, com ou sem prefixo", () => {
    for (const code of ["error_inner", "error_system_busy", "error_rate_limit", "product.error_inner", "error_server", "error_network"]) {
      expect(erro(code).errorClass).toBe("retryable");
    }

    expect(erro("error_param").errorClass).toBe("not_retryable");
    expect(erro("product.error_item_not_found").errorClass).toBe("not_retryable");
    expect(erro(null, 503).errorClass).toBe("retryable");
  });

  it("D-432: credencial, assinatura, partner e loja inválida são da LOJA, não do pedido — com ou sem prefixo", () => {
    for (const code of ["error_auth", "error_shop", "error_sign", "error_permission", "invalid_partner_id", "invalid_acceess_token", "common.error_auth"]) {
      expect(isShopLevelError(erro(code))).toBe(true);
    }

    for (const code of ["error_param", "order_not_found", "error_server", "product.error_item_not_found"]) {
      expect(isShopLevelError(erro(code))).toBe(false);
    }

    expect(isShopLevelError(new Error("error_auth"))).toBe(false);
  });
});

