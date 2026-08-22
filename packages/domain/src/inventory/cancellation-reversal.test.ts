import { describe, expect, it } from "vitest";

import { computeCancellationReversals } from "./cancellation-reversal.js";
import type { CancellationReversalOrder, RecordedSaleMovement } from "./cancellation-reversal.js";

const OCCURRED_AT = new Date("2026-08-22T13:00:00.000Z");

function baseOrder(overrides: Partial<CancellationReversalOrder> = {}): CancellationReversalOrder {
  return {
    id: 9900001001,
    status: "cancelled",
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

const SALE_MOVEMENTS: RecordedSaleMovement[] = [
  { skuId: "sku-parafuso", qtyDelta: -3, idempotencyKey: "venda:9900001001:0" },
];

describe("computeCancellationReversals", () => {
  it.each(["paid", "partially_refunded", "confirmed", "payment_required", "invalid"])(
    "status %s não reverte nada, mesmo com movimentos de venda gravados",
    (status) => {
      const order = baseOrder({ status });

      expect(computeCancellationReversals(order, SALE_MOVEMENTS)).toEqual([]);
    },
  );

  it.each(["cancelled", "pending_cancel"])("reverte cada movimento VENDA_ML com quantidade invertida (%s)", (status) => {
    const order = baseOrder({ status });

    expect(computeCancellationReversals(order, SALE_MOVEMENTS)).toEqual([
      {
        skuId: "sku-parafuso",
        qtyDelta: 3,
        idempotencyKey: "cancelamento:venda:9900001001:0",
        occurredAt: OCCURRED_AT,
      },
    ]);
  });

  it("KIT: reverte uma linha por componente, na mesma forma gravada pela venda", () => {
    const kitMovements: RecordedSaleMovement[] = [
      { skuId: "sku-lampada", qtyDelta: -4, idempotencyKey: "venda:9900001001:1:sku-lampada" },
      { skuId: "sku-suporte", qtyDelta: -2, idempotencyKey: "venda:9900001001:1:sku-suporte" },
    ];

    const result = computeCancellationReversals(baseOrder(), kitMovements);

    expect(result).toEqual([
      {
        skuId: "sku-lampada",
        qtyDelta: 4,
        idempotencyKey: "cancelamento:venda:9900001001:1:sku-lampada",
        occurredAt: OCCURRED_AT,
      },
      {
        skuId: "sku-suporte",
        qtyDelta: 2,
        idempotencyKey: "cancelamento:venda:9900001001:1:sku-suporte",
        occurredAt: OCCURRED_AT,
      },
    ]);
  });

  it("nenhum movimento de venda gravado (item nunca foi vinculado) não reverte nada", () => {
    expect(computeCancellationReversals(baseOrder(), [])).toEqual([]);
  });

  it("chave de idempotência é determinística — reprocessar o mesmo cancelamento produz a MESMA chave", () => {
    const first = computeCancellationReversals(baseOrder(), SALE_MOVEMENTS);
    const second = computeCancellationReversals(baseOrder(), SALE_MOVEMENTS);

    expect(first[0]?.idempotencyKey).toBe(second[0]?.idempotencyKey);
  });
});
