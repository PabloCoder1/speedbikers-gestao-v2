import { describe, expect, it } from "vitest";

import type { RecordedSaleMovement } from "./cancellation-reversal.js";
import { computeReturnReversal } from "./return-reversal.js";

const OCCURRED_AT = new Date("2026-08-23T09:00:00.000Z");
const ORDER = { id: 2000009229357366 };
const CLAIM_ID = "5298178312";

describe("computeReturnReversal", () => {
  it("PRODUTO: devolução total reverte o único movimento da posição", () => {
    const saleMovements: RecordedSaleMovement[] = [
      { skuId: "sku-a", qtyDelta: -3, idempotencyKey: `venda:${String(ORDER.id)}:0` },
    ];

    const result = computeReturnReversal(
      ORDER,
      { position: 0, totalQuantity: 3, returnQuantity: 3 },
      saleMovements,
      CLAIM_ID,
      OCCURRED_AT,
    );

    expect(result.fullReversal).toBe(true);
    expect(result.movements).toHaveLength(1);
    expect(result.movements[0]).toMatchObject({
      skuId: "sku-a",
      qtyDelta: 3,
      idempotencyKey: `devolucao:${CLAIM_ID}:venda:${String(ORDER.id)}:0`,
    });
  });

  it("KIT: devolução total reverte TODOS os movimentos de componente da posição, nenhum de outra posição", () => {
    const saleMovements: RecordedSaleMovement[] = [
      { skuId: "comp-1", qtyDelta: -6, idempotencyKey: `venda:${String(ORDER.id)}:1:comp-1` },
      { skuId: "comp-2", qtyDelta: -2, idempotencyKey: `venda:${String(ORDER.id)}:1:comp-2` },
      { skuId: "sku-outra-posicao", qtyDelta: -1, idempotencyKey: `venda:${String(ORDER.id)}:0` },
    ];

    const result = computeReturnReversal(
      ORDER,
      { position: 1, totalQuantity: 2, returnQuantity: 2 },
      saleMovements,
      CLAIM_ID,
      OCCURRED_AT,
    );

    expect(result.fullReversal).toBe(true);
    expect(result.movements).toHaveLength(2);
    expect(result.movements.map((m) => m.skuId).sort()).toEqual(["comp-1", "comp-2"]);
    expect(result.movements.every((m) => m.qtyDelta > 0)).toBe(true);
  });

  it("devolução parcial não gera movimento nenhum — precisa de ajuste manual", () => {
    const saleMovements: RecordedSaleMovement[] = [
      { skuId: "sku-a", qtyDelta: -5, idempotencyKey: `venda:${String(ORDER.id)}:0` },
    ];

    const result = computeReturnReversal(
      ORDER,
      { position: 0, totalQuantity: 5, returnQuantity: 2 },
      saleMovements,
      CLAIM_ID,
      OCCURRED_AT,
    );

    expect(result.fullReversal).toBe(false);
    expect(result.movements).toHaveLength(0);
    expect(result.event.after).toMatchObject({ needsManualReview: true });
  });

  it("nenhum movimento de venda encontrado para a posição: não finge reversão total", () => {
    const result = computeReturnReversal(
      ORDER,
      { position: 0, totalQuantity: 1, returnQuantity: 1 },
      [],
      CLAIM_ID,
      OCCURRED_AT,
    );

    expect(result.fullReversal).toBe(false);
    expect(result.movements).toHaveLength(0);
  });

  it("evento é sempre emitido, mesmo na devolução parcial — sinal para investigação", () => {
    const result = computeReturnReversal(
      ORDER,
      { position: 0, totalQuantity: 4, returnQuantity: 1 },
      [{ skuId: "sku-a", qtyDelta: -4, idempotencyKey: `venda:${String(ORDER.id)}:0` }],
      CLAIM_ID,
      OCCURRED_AT,
    );

    expect(result.event.eventType).toBe("order.returned");
    expect(result.event.severity).toBe("importante");
    expect(result.event.dedupKey).toBe(`order.returned:${CLAIM_ID}:0`);
  });

  it("reprocessar o mesmo claim produz as mesmas chaves — idempotente", () => {
    const saleMovements: RecordedSaleMovement[] = [
      { skuId: "sku-a", qtyDelta: -3, idempotencyKey: `venda:${String(ORDER.id)}:0` },
    ];

    const first = computeReturnReversal(
      ORDER,
      { position: 0, totalQuantity: 3, returnQuantity: 3 },
      saleMovements,
      CLAIM_ID,
      OCCURRED_AT,
    );
    const second = computeReturnReversal(
      ORDER,
      { position: 0, totalQuantity: 3, returnQuantity: 3 },
      saleMovements,
      CLAIM_ID,
      OCCURRED_AT,
    );

    expect(first.movements[0]?.idempotencyKey).toBe(second.movements[0]?.idempotencyKey);
    expect(first.event.dedupKey).toBe(second.event.dedupKey);
  });
});
