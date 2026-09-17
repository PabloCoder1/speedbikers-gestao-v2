import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import { MercadoLivreApiError } from "./errors.js";
import { createMercadoLivreClient } from "./http-client.js";
import { USER_PRODUCT_SELLER_TAG, fetchIsUserProductSeller } from "./users.js";

function clienteCom(status: number, corpo: unknown, captura: { url?: URL; headers?: Record<string, string> } = {}) {
  const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    captura.url = new URL(url as string | URL);
    captura.headers = init?.headers as Record<string, string>;

    return Promise.resolve(new Response(JSON.stringify(corpo), { status }));
  });

  return {
    client: createMercadoLivreClient({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: () => Promise.resolve(), maxAttempts: 1 }),
    fetchImpl,
  };
}

describe("fetchIsUserProductSeller (D-369)", () => {
  it("lê as tags de /users/me com o token da conta: com user_product_seller, true", async () => {
    const captura: { url?: URL; headers?: Record<string, string> } = {};
    const { client } = clienteCom(200, { id: 244_878_077, tags: ["normal", "user_product_seller", "eshop"] }, captura);

    await expect(fetchIsUserProductSeller({ client, accessToken: "APP_USR-teste" })).resolves.toBe(true);
    expect(captura.url?.pathname).toBe("/users/me");
    expect(captura.headers?.authorization).toBe("Bearer APP_USR-teste");
    expect(USER_PRODUCT_SELLER_TAG).toBe("user_product_seller");
  });

  it("tags sem a de user products: false — inclusive tag parecida", async () => {
    for (const tags of [[], ["normal"], ["user_product_listing", "user_product_seller_candidate"]]) {
      const { client } = clienteCom(200, { id: 1, tags });

      await expect(fetchIsUserProductSeller({ client, accessToken: "APP_USR-teste" })).resolves.toBe(false);
    }
  });

  it("sem tags legíveis ou com erro HTTP, LANÇA — quem chama decide, e a regra é bloquear", async () => {
    for (const corpo of [{ id: 1 }, { id: 1, tags: "user_product_seller" }, { id: 1, tags: [1] }]) {
      const { client } = clienteCom(200, corpo);

      await expect(fetchIsUserProductSeller({ client, accessToken: "APP_USR-teste" })).rejects.toBeInstanceOf(ZodError);
    }

    const { client } = clienteCom(403, { message: "forbidden" });

    await expect(fetchIsUserProductSeller({ client, accessToken: "APP_USR-teste" })).rejects.toBeInstanceOf(MercadoLivreApiError);
  });
});
