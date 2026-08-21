import { describe, expect, it } from "vitest";

import { computeSaleDeductions } from "./sale-deduction.js";
import type { SaleDeductionOrder } from "./sale-deduction.js";

const OCCURRED_AT = new Date("2026-08-21T13:00:00.000Z");

function baseOrder(overrides: Partial<SaleDeductionOrder> = {}): SaleDeductionOrder {
  return {
    id: 9900001001,
    status: "paid",
    occurredAt: OCCURRED_AT,
    items: [],
    ...overrides,
  };
}

describe("computeSaleDeductions", () => {
  it.each(["confirmed", "payment_required", "payment_in_process", "cancelled", "pending_cancel", "invalid"])(
    "status %s não deduz nada",
    (status) => {
      const order = baseOrder({
        status,
        items: [{ position: 0, quantity: 1, skuId: "sku-1", skuKind: "PRODUTO", components: [] }],
      });

      expect(computeSaleDeductions(order)).toEqual([]);
    },
  );

  it("PRODUTO: uma linha, quantidade negativa", () => {
    const order = baseOrder({
      items: [{ position: 0, quantity: 3, skuId: "sku-parafuso", skuKind: "PRODUTO", components: [] }],
    });

    expect(computeSaleDeductions(order)).toEqual([
      {
        skuId: "sku-parafuso",
        qtyDelta: -3,
        idempotencyKey: "venda:9900001001:0",
        occurredAt: OCCURRED_AT,
      },
    ]);
  });

  it("KIT: uma linha por componente, quantidade do item vezes quantidade do componente", () => {
    const order = baseOrder({
      items: [
        {
          position: 1,
          quantity: 2,
          skuId: "sku-kit-farol",
          skuKind: "KIT",
          components: [
            { componentSkuId: "sku-lampada", quantity: 2 },
            { componentSkuId: "sku-suporte", quantity: 1 },
          ],
        },
      ],
    });

    expect(computeSaleDeductions(order)).toEqual([
      {
        skuId: "sku-lampada",
        qtyDelta: -4,
        idempotencyKey: "venda:9900001001:1:sku-lampada",
        occurredAt: OCCURRED_AT,
      },
      {
        skuId: "sku-suporte",
        qtyDelta: -2,
        idempotencyKey: "venda:9900001001:1:sku-suporte",
        occurredAt: OCCURRED_AT,
      },
    ]);
  });

  it("item sem vínculo (skuId nulo) não gera movimento", () => {
    const order = baseOrder({
      items: [{ position: 0, quantity: 1, skuId: null, skuKind: null, components: [] }],
    });

    expect(computeSaleDeductions(order)).toEqual([]);
  });

  it("pedido com PRODUTO, KIT e item sem vínculo juntos", () => {
    const order = baseOrder({
      items: [
        { position: 0, quantity: 1, skuId: "sku-a", skuKind: "PRODUTO", components: [] },
        {
          position: 1,
          quantity: 1,
          skuId: "sku-kit",
          skuKind: "KIT",
          components: [{ componentSkuId: "sku-b", quantity: 3 }],
        },
        { position: 2, quantity: 5, skuId: null, skuKind: null, components: [] },
      ],
    });

    const result = computeSaleDeductions(order);

    expect(result).toHaveLength(2);
    expect(result.map((d) => d.skuId)).toEqual(["sku-a", "sku-b"]);
  });

  it("paid e partially_refunded produzem a MESMA chave de idempotência — reprocessar não duplica", () => {
    const items: SaleDeductionOrder["items"] = [
      { position: 0, quantity: 1, skuId: "sku-a", skuKind: "PRODUTO", components: [] },
    ];

    const paid = computeSaleDeductions(baseOrder({ status: "paid", items }));
    const partiallyRefunded = computeSaleDeductions(baseOrder({ status: "partially_refunded", items }));

    expect(paid[0]?.idempotencyKey).toBe(partiallyRefunded[0]?.idempotencyKey);
  });

  it("pedido sem itens não deduz nada", () => {
    expect(computeSaleDeductions(baseOrder({ items: [] }))).toEqual([]);
  });
});
