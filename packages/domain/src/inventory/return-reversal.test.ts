import { describe, expect, it } from "vitest";

import type { RecordedSaleMovement } from "./cancellation-reversal.js";
import { computeReturnReversal, computeUnreversedReturn } from "./return-reversal.js";

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

/**
 * O caso em que NAO da para reverter (D-208).
 *
 * Sem a linha de `order_items` nao existe `position`, e sem `position` a
 * venda original nao e localizavel — entao nao ha reversao possivel. O que
 * estes testes fixam nao e um calculo, e a EXISTENCIA DO RASTRO: ate D-208 a
 * perda so aparecia num `logger.warn`, e o banco nao guardava nada.
 */
describe("computeUnreversedReturn", () => {
  const claimId = "5099999999";
  const occurredAt = new Date("2026-09-02T12:00:00.000Z");

  it("marca a perda como critica e pedindo gente", () => {
    const evento = computeUnreversedReturn(
      { id: 2000017347483988 },
      { itemId: "MLB123", variationId: null, returnQuantity: 1 },
      claimId,
      occurredAt,
    );

    expect(evento.eventType).toBe("order.return.unreversed");
    expect(evento.severity).toBe("critico");
    expect(evento.entityType).toBe("order");
    expect(evento.entityId).toBe("2000017347483988");

    // `needsManualReview` e o campo que distingue esta perda de um no-op
    // legitimo — que e comum (D-205 mediu 4.903 execucoes de post_purchase
    // que sao filtro de dominio saudavel).
    expect(evento.after).toMatchObject({ reason: "order_item_not_found", needsManualReview: true });
  });

  it("deduplica pelo item dentro do claim, ja que a position e justamente o que falta", () => {
    const base = { itemId: "MLB123", variationId: null, returnQuantity: 1 };

    const a = computeUnreversedReturn({ id: 1 }, base, claimId, occurredAt);
    const b = computeUnreversedReturn({ id: 1 }, base, claimId, new Date("2026-09-03T00:00:00.000Z"));

    // Reprocessar o mesmo claim nao pode multiplicar o alerta: a identidade
    // do fato nao inclui o instante.
    expect(a.dedupKey).toBe(b.dedupKey);
  });

  it("separa variacoes do MESMO item no mesmo claim", () => {
    const a = computeUnreversedReturn({ id: 1 }, { itemId: "MLB123", variationId: "77", returnQuantity: 1 }, claimId, occurredAt);
    const b = computeUnreversedReturn({ id: 1 }, { itemId: "MLB123", variationId: "88", returnQuantity: 1 }, claimId, occurredAt);

    // Sao duas perdas distintas de estoque. Se a chave as fundisse, a
    // segunda sumiria por deduplicacao — o buraco que o evento existe para
    // fechar reabriria em silencio.
    expect(a.dedupKey).not.toBe(b.dedupKey);
  });
});
