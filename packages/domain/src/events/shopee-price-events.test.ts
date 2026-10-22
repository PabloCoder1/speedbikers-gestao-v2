import { describe, expect, it } from "vitest";

import { detectShopeePriceEvents, type ShopeePriceReading } from "./shopee-price-events.js";

const LOJA = "5b0e7a2c-0000-4000-8000-000000000081";
const LIDO = new Date("2026-10-21T20:00:00.000Z");

function leitura(over: Partial<ShopeePriceReading> = {}): ShopeePriceReading {
  return {
    itemId: 1001,
    modelId: null,
    modelName: null,
    itemName: "Capacete X",
    price: 100,
    currentPrice: 100,
    ...over,
  };
}

describe("detectShopeePriceEvents (C-81)", () => {
  it("o preço do item sem variação que muda vira listing.price.changed da loja", () => {
    const eventos = detectShopeePriceEvents({
      shopeeShopId: LOJA,
      shopName: "Loja SB",
      previous: [leitura()],
      current: [leitura({ price: 120, currentPrice: 110 })],
      readAt: LIDO,
    });

    expect(eventos).toEqual([
      {
        eventType: "listing.price.changed",
        entityType: "shopee_item",
        entityId: "1001",
        before: { price: 100, current_price: 100, model_id: null },
        after: {
          price: 120,
          current_price: 110,
          model_id: null,
          model_name: null,
          item_name: "Capacete X",
          shop_name: "Loja SB",
        },
        severity: "informativo",
        source: "sync",
        dedupKey: `listing.price.changed:shopee:${LOJA}:1001:item:2026-10-21T20:00:00.000Z`,
        occurredAt: LIDO,
      },
    ]);
  });

  it("cada variação é comparada com ela mesma, e só a que mudou gera evento", () => {
    const eventos = detectShopeePriceEvents({
      shopeeShopId: LOJA,
      shopName: "Loja SB",
      previous: [leitura({ modelId: 1, price: 50 }), leitura({ modelId: 2, price: 60 })],
      current: [leitura({ modelId: 1, price: 50 }), leitura({ modelId: 2, modelName: "Azul / G", price: 55 })],
      readAt: LIDO,
    });

    expect(eventos.map((e) => [e.after, e.dedupKey])).toEqual([
      [
        {
          price: 55,
          current_price: 100,
          model_id: 2,
          model_name: "Azul / G",
          item_name: "Capacete X",
          shop_name: "Loja SB",
        },
        `listing.price.changed:shopee:${LOJA}:1001:2:2026-10-21T20:00:00.000Z`,
      ],
    ]);
  });

  it("a promoção sozinha (só o current_price) não é mudança de preço", () => {
    expect(
      detectShopeePriceEvents({
        shopeeShopId: LOJA,
        shopName: "Loja SB",
        previous: [leitura({ currentPrice: 100 })],
        current: [leitura({ currentPrice: 79.9 })],
        readAt: LIDO,
      }),
    ).toEqual([]);
  });

  it("sem leitura anterior, com um lado nulo, ou com a variação nova ou removida, não há evento", () => {
    const semAnterior = detectShopeePriceEvents({
      shopeeShopId: LOJA,
      shopName: "Loja SB",
      previous: [],
      current: [leitura()],
      readAt: LIDO,
    });
    const anteriorNulo = detectShopeePriceEvents({
      shopeeShopId: LOJA,
      shopName: "Loja SB",
      previous: [leitura({ price: null })],
      current: [leitura({ price: 90 })],
      readAt: LIDO,
    });
    const atualNulo = detectShopeePriceEvents({
      shopeeShopId: LOJA,
      shopName: "Loja SB",
      previous: [leitura({ price: 90 })],
      current: [leitura({ price: null })],
      readAt: LIDO,
    });
    // O item ganhou variações: o preço do item não é o de nenhuma delas.
    const virouVariacao = detectShopeePriceEvents({
      shopeeShopId: LOJA,
      shopName: "Loja SB",
      previous: [leitura({ price: 90 })],
      current: [leitura({ modelId: 7, price: 95 })],
      readAt: LIDO,
    });

    expect([semAnterior, anteriorNulo, atualNulo, virouVariacao]).toEqual([[], [], [], []]);
  });

  it("o mesmo id de variação em itens diferentes não se confunde", () => {
    const eventos = detectShopeePriceEvents({
      shopeeShopId: LOJA,
      shopName: "Loja SB",
      previous: [leitura({ itemId: 1, modelId: 5, price: 10 }), leitura({ itemId: 2, modelId: 5, price: 20 })],
      current: [leitura({ itemId: 1, modelId: 5, price: 10 }), leitura({ itemId: 2, modelId: 5, price: 25 })],
      readAt: LIDO,
    });

    expect(eventos.map((e) => e.entityId)).toEqual(["2"]);
  });
});
