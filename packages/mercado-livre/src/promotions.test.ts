import { describe, expect, it, vi } from "vitest";

import { createMercadoLivreClient } from "./http-client.js";
import { effectivePromotionalPrice, getItemPromotions } from "./promotions.js";

function clienteCom(status: number, corpo: unknown, captura: { url?: URL } = {}) {
  const fetchImpl = vi.fn((url: string | URL | Request) => {
    captura.url = new URL(url as string | URL);

    return Promise.resolve(new Response(JSON.stringify(corpo), { status }));
  });

  return createMercadoLivreClient({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: () => Promise.resolve() });
}

describe("getItemPromotions", () => {
  it("monta a chamada com app_version=v2", async () => {
    const captura: { url?: URL } = {};
    const client = clienteCom(200, [], captura);

    await getItemPromotions({ client, itemId: "MLB123", accessToken: "APP_USR-teste" });

    expect(captura.url?.pathname).toBe("/seller-promotions/items/MLB123");
    expect(captura.url?.searchParams.get("app_version")).toBe("v2");
  });

  it("devolve as campanhas tal como o Mercado Livre respondeu (exemplo real, 2026-09-21)", async () => {
    const client = clienteCom(200, [
      {
        id: "C-MLB5512634",
        type: "SELLER_CAMPAIGN",
        sub_type: "FLEXIBLE_PERCENTAGE",
        status: "started",
        price: 249.99,
        original_price: 370.69,
        start_date: "2026-09-12T00:00:00",
        finish_date: "2026-09-26T23:59:59",
        name: "11_8009_8008_8007_8006_8",
      },
      { type: "PRICE_DISCOUNT", status: "candidate", price: 0, original_price: 370.69, name: "" },
    ]);

    const promocoes = await getItemPromotions({ client, itemId: "MLB1384467402", accessToken: "APP_USR-teste" });

    expect(promocoes).toHaveLength(2);
    expect(promocoes[0]).toMatchObject({ status: "started", price: 249.99 });
  });

  it("403 (item fora de qualquer campanha) vira lista vazia, não erro", async () => {
    const client = clienteCom(403, {
      message: "Caller don't have permissions to access this item",
      error: "forbidden",
      status: 403,
      cause: [],
    });

    await expect(getItemPromotions({ client, itemId: "MLB999", accessToken: "APP_USR-teste" })).resolves.toEqual([]);
  });

  it("outro erro (ex.: 500) continua sendo erro — só 403 é silencioso", async () => {
    const client = clienteCom(500, { message: "erro interno" }, {});

    await expect(getItemPromotions({ client, itemId: "MLB999", accessToken: "APP_USR-teste" })).rejects.toThrow();
  });
});

describe("effectivePromotionalPrice", () => {
  it("ignora campanhas 'candidate' (price 0) e usa a 'started'", () => {
    const preco = effectivePromotionalPrice([
      { type: "SELLER_CAMPAIGN", status: "started", price: 249.99, original_price: 370.69 },
      { type: "PRICE_DISCOUNT", status: "candidate", price: 0, original_price: 370.69 },
      { type: "DEAL", status: "candidate", price: 0, original_price: 370.69 },
    ]);

    expect(preco).toBe(249.99);
  });

  it("null quando não há nenhuma campanha 'started'", () => {
    expect(
      effectivePromotionalPrice([{ type: "PRICE_DISCOUNT", status: "candidate", price: 0, original_price: 100 }]),
    ).toBeNull();
    expect(effectivePromotionalPrice([])).toBeNull();
  });

  it("o MENOR preço entre várias campanhas 'started' simultâneas", () => {
    const preco = effectivePromotionalPrice([
      { type: "SELLER_CAMPAIGN", status: "started", price: 60, original_price: 100 },
      { type: "DEAL", status: "started", price: 45, original_price: 100 },
    ]);

    expect(preco).toBe(45);
  });
});
