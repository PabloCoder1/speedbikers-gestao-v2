import { describe, expect, it, vi } from "vitest";

import { createMercadoLivreClient } from "./http-client.js";
import { quoteFreeShippingCost, quoteSaleFixedFee } from "./shipping-quote.js";

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
  freteGratis: true,
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

describe("free_shipping é a escolha do vendedor (D-421)", () => {
  it("sem frete grátis, a chamada leva free_shipping=false", async () => {
    const captura: { url?: URL } = {};
    const client = clienteCom({ coverage: { all_country: { list_cost: 8.25, currency_id: "BRL" } } }, captura);

    await expect(quoteFreeShippingCost(client, { ...INPUT, preco: 50, freteGratis: false })).resolves.toMatchObject({
      custoVendedor: 8.25,
    });
    expect(captura.url?.searchParams.get("free_shipping")).toBe("false");
  });
});

describe("quoteSaleFixedFee (D-421)", () => {
  const FIXA = { accessToken: "APP_USR-teste", preco: 50, listingTypeId: "gold_special", logistica: "self_service", pesoFaturavelG: 512.4 } as const;

  it("monta a chamada da doc: preço, tipo, BRL, logística, me2 e peso faturável inteiro", async () => {
    const captura: { url?: URL } = {};
    const client = clienteCom([{ sale_fee_details: { fixed_fee: 7.75, percentage_fee: 11 } }], captura);

    await expect(quoteSaleFixedFee(client, FIXA)).resolves.toBe(7.75);
    expect(captura.url?.pathname).toBe("/sites/MLB/listing_prices");
    expect(captura.url?.searchParams.get("price")).toBe("50");
    expect(captura.url?.searchParams.get("listing_type_id")).toBe("gold_special");
    expect(captura.url?.searchParams.get("currency_id")).toBe("BRL");
    expect(captura.url?.searchParams.get("logistic_type")).toBe("self_service");
    expect(captura.url?.searchParams.get("shipping_mode")).toBe("me2");
    expect(captura.url?.searchParams.get("billable_weight")).toBe("512");
  });

  it("aceita a resposta como objeto, não só lista", async () => {
    const client = clienteCom({ sale_fee_details: { fixed_fee: 0 } });

    await expect(quoteSaleFixedFee(client, { ...FIXA, logistica: "cross_docking" })).resolves.toBe(0);
  });

  it("resposta sem fixed_fee é recusada, nunca vira zero", async () => {
    const client = clienteCom([{ sale_fee_details: {} }]);

    await expect(quoteSaleFixedFee(client, FIXA)).rejects.toThrow();
  });
});
