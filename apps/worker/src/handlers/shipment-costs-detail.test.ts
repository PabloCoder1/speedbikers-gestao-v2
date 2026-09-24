import { describe, expect, it } from "vitest";

import { detalheDoFrete, detalheFecha } from "./shipment-costs-detail.js";

/**
 * Respostas reais de `GET /shipments/{id}/costs` (produção, 24/09), com os
 * `user_id` trocados. Os valores e a forma são os que vieram.
 */
function envio(parcial: { gross: number; comprador: unknown; vendedor: unknown }): {
  gross_amount: unknown;
  receiver: unknown;
  senders: { cost: number; discounts?: unknown }[];
} {
  return {
    gross_amount: parcial.gross,
    receiver: parcial.comprador,
    senders: [parcial.vendedor as { cost: number; discounts?: unknown }],
  };
}

/** Full, frete grátis para o comprador: o Mercado Livre banca a parte dele e metade da do vendedor. */
const FULL_FRETE_GRATIS = envio({
  gross: 78.9,
  comprador: {
    compensations: [],
    fees: [],
    cost: 0,
    discounts: [{ rate: 1, type: "ratio", promoted_amount: 24.8 }],
    user_id: 1,
    cost_details: [],
    save: 24.8,
    compensation: 0,
  },
  vendedor: {
    compensations: [],
    charges: { charge_flex: 0 },
    fees: [],
    cost: 27.05,
    discounts: [{ rate: 0.5, type: "mandatory", promoted_amount: 27.05 }],
    user_id: 2,
    save: 27.05,
    compensation: 0,
  },
});

/** Coleta com o comprador pagando parte: o `save` (8,01) veio menor que o desconto (9). */
const COMPRADOR_PAGA = envio({
  gross: 30.78,
  comprador: {
    cost: 9.99,
    discounts: [{ rate: 0.47, type: "gap", promoted_amount: 9 }],
    cost_details: [{ sender_id: 2, amount: 9.99 }],
    save: 8.01,
    compensation: 0,
  },
  vendedor: { cost: 8.25, discounts: [{ rate: 0.3, type: "mandatory", promoted_amount: 3.54 }], save: 3.54 },
});

/** Flex: o vendedor não paga, e não há desconto dele -- zero observado. */
const FLEX = envio({
  gross: 8.99,
  comprador: { cost: 0, discounts: [{ rate: 1, type: "loyal", promoted_amount: 8.99 }], save: 8.99 },
  vendedor: { cost: 0, discounts: [], save: 0 },
});

describe("detalheDoFrete (D-407)", () => {
  it("lê as quatro partes da forma real, e o frete cheio fecha com elas", () => {
    const d = detalheDoFrete(FULL_FRETE_GRATIS);

    expect(d).toEqual({
      shipping_list_cost: 78.9,
      seller_shipping_subsidy: 27.05,
      buyer_shipping_cost: 0,
      buyer_shipping_subsidy: 24.8,
    });
    expect(detalheFecha(d, 27.05)).toBe(true);
  });

  it("o desconto é o promoted_amount, não o save: só assim a conta fecha", () => {
    const d = detalheDoFrete(COMPRADOR_PAGA);

    expect(d).toMatchObject({ buyer_shipping_cost: 9.99, buyer_shipping_subsidy: 9, seller_shipping_subsidy: 3.54 });
    expect(detalheFecha(d, 8.25)).toBe(true);
  });

  it("vários descontos somam em centavos; lista vazia é zero observado", () => {
    const doisDescontos = envio({
      gross: 42.6,
      comprador: {
        cost: 0,
        discounts: [
          { rate: 0.34, type: "loyal", promoted_amount: 10.1 },
          { rate: 0.66, type: "ratio", promoted_amount: 20 },
        ],
      },
      vendedor: { cost: 8.75, discounts: [{ rate: 0.3, type: "mandatory", promoted_amount: 3.75 }] },
    });

    expect(detalheDoFrete(doisDescontos).buyer_shipping_subsidy).toBe(30.1);
    expect(detalheFecha(detalheDoFrete(doisDescontos), 8.75)).toBe(true);
    expect(detalheDoFrete(FLEX)).toEqual({
      shipping_list_cost: 8.99,
      seller_shipping_subsidy: 0,
      buyer_shipping_cost: 0,
      buyer_shipping_subsidy: 8.99,
    });
  });

  it("parte fora da forma vira null sem apagar as outras", () => {
    const semComprador = { ...FULL_FRETE_GRATIS, receiver: null };
    const descontoEstranho = {
      ...FULL_FRETE_GRATIS,
      senders: [{ cost: 27.05, discounts: [{ type: "mandatory", promoted_amount: -1 }] }],
    };

    expect(detalheDoFrete(semComprador)).toEqual({
      shipping_list_cost: 78.9,
      seller_shipping_subsidy: 27.05,
      buyer_shipping_cost: null,
      buyer_shipping_subsidy: null,
    });
    expect(detalheDoFrete(descontoEstranho).seller_shipping_subsidy).toBeNull();
    expect(detalheFecha(detalheDoFrete(semComprador), 27.05)).toBeNull();
  });

  it("a resposta mínima (só o custo do vendedor) não inventa nada", () => {
    expect(detalheDoFrete({ senders: [{ cost: 12.5 }] })).toEqual({
      shipping_list_cost: null,
      seller_shipping_subsidy: null,
      buyer_shipping_cost: null,
      buyer_shipping_subsidy: null,
    });
  });

  it("com mais de um vendedor, o desconto soma; um ilegível deixa a soma não observada", () => {
    const dois = { ...FLEX, senders: [{ cost: 5, discounts: [{ promoted_amount: 1 }] }, { cost: 5, discounts: [] }] };
    const umIlegivel = { ...FLEX, senders: [{ cost: 5, discounts: [{ promoted_amount: 1 }] }, { cost: 5 }] };

    expect(detalheDoFrete(dois).seller_shipping_subsidy).toBe(1);
    expect(detalheDoFrete(umIlegivel).seller_shipping_subsidy).toBeNull();
  });

  it("conta que não fecha é dita (false), não corrigida", () => {
    const d = detalheDoFrete({ ...FLEX, gross_amount: 20 });

    expect(d.shipping_list_cost).toBe(20);
    expect(detalheFecha(d, 0)).toBe(false);
  });
});
