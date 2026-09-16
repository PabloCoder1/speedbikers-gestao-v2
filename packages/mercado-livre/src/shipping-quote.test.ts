import { describe, expect, it, vi } from "vitest";

import { createMercadoLivreClient } from "./http-client.js";
import { quoteFreeShippingCost } from "./shipping-quote.js";

const INPUT = {
  sellerId: 244878077,
  accessToken: "APP_USR-teste",
  alturaCm: 9,
  larguraCm: 17,
  comprimentoCm: 22.4,
  pesoG: 462,
  preco: 300,
  listingTypeId: "gold_pro",
  logistica: "drop_off",
} as const;

function clienteCom(corpo: unknown, captura: { url?: URL; headers?: Record<string, string> } = {}) {
  const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    captura.url = new URL(url as string | URL);
    captura.headers = init?.headers as Record<string, string>;

    return Promise.resolve(new Response(JSON.stringify(corpo), { status: 200 }));
  });

  return createMercadoLivreClient({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: () => Promise.resolve() });
}

describe("quoteFreeShippingCost", () => {
  it("monta a chamada da doc oficial: dimensões AxLxC,peso, preço, tipo, me2 e free_shipping", async () => {
    const captura: { url?: URL; headers?: Record<string, string> } = {};
    const client = clienteCom({ coverage: { all_country: { list_cost: 21.9, currency_id: "BRL", billable_weight: 600 } } }, captura);

    const cotacao = await quoteFreeShippingCost(client, INPUT);

    expect(captura.url?.pathname).toBe("/users/244878077/shipping_options/free");
    expect(captura.url?.searchParams.get("dimensions")).toBe("9x17x22,462");
    expect(captura.url?.searchParams.get("item_price")).toBe("300");
    expect(captura.url?.searchParams.get("listing_type_id")).toBe("gold_pro");
    expect(captura.url?.searchParams.get("mode")).toBe("me2");
    expect(captura.url?.searchParams.get("logistic_type")).toBe("drop_off");
    expect(captura.url?.searchParams.get("free_shipping")).toBe("true");
    expect(captura.headers?.Authorization ?? captura.headers?.authorization).toBe("Bearer APP_USR-teste");
    expect(cotacao).toEqual({
      custoVendedor: 21.9,
      moeda: "BRL",
      pesoFaturavelG: 600,
      custoSemDesconto: null,
      descontoPercentual: null,
    });
  });

  it("lê o desconto quando o Mercado Livre informa (list_cost já vem descontado)", async () => {
    const client = clienteCom({
      coverage: {
        all_country: { list_cost: 120, currency_id: "BRL" },
        discount: { rate: 0.4, type: "loyal", promoted_amount: 200 },
      },
    });

    await expect(quoteFreeShippingCost(client, INPUT)).resolves.toMatchObject({
      custoVendedor: 120,
      custoSemDesconto: 200,
      descontoPercentual: 0.4,
    });
  });

  it("recusa resposta sem list_cost em vez de devolver frete zero", async () => {
    const client = clienteCom({ coverage: { all_country: { currency_id: "BRL" } } });

    await expect(quoteFreeShippingCost(client, INPUT)).rejects.toThrow();
  });
});
