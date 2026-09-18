import { describe, expect, it } from "vitest";

import { computeReturnReversal, computeUnreversedReturn } from "./return-reversal.js";
import type { ReturnedSaleMovement } from "./return-reversal.js";

const OCCURRED_AT = new Date("2026-08-23T09:00:00.000Z");
const ORDER = { id: 2000009229357366, logisticType: null };
/** Quando a venda foi gravada: o instante que o ESTORNO_FULL espelha (D-352). */
const VENDIDO_EM = new Date("2026-08-20T10:00:00.000Z");
/** Quando uma reversao ja gravada aconteceu: o instante que a anulacao dela espelha. */
const REVERTIDO_EM = new Date("2026-08-22T11:00:00.000Z");
const CLAIM_ID = "5298178312";

describe("computeReturnReversal", () => {
  it("PRODUTO: devolução total reverte o único movimento da posição", () => {
    const saleMovements: ReturnedSaleMovement[] = [
      { skuId: "sku-a", qtyDelta: -3, idempotencyKey: `venda:${String(ORDER.id)}:0`, occurredAt: VENDIDO_EM },
    ];

    const result = computeReturnReversal(
      ORDER,
      { position: 0, totalQuantity: 3, returnQuantity: 3 },
      saleMovements,
      [],
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
    const saleMovements: ReturnedSaleMovement[] = [
      { skuId: "comp-1", qtyDelta: -6, idempotencyKey: `venda:${String(ORDER.id)}:1:comp-1`, occurredAt: VENDIDO_EM },
      { skuId: "comp-2", qtyDelta: -2, idempotencyKey: `venda:${String(ORDER.id)}:1:comp-2`, occurredAt: VENDIDO_EM },
      { skuId: "sku-outra-posicao", qtyDelta: -1, idempotencyKey: `venda:${String(ORDER.id)}:0`, occurredAt: VENDIDO_EM },
    ];

    const result = computeReturnReversal(
      ORDER,
      { position: 1, totalQuantity: 2, returnQuantity: 2 },
      saleMovements,
      [],
      CLAIM_ID,
      OCCURRED_AT,
    );

    expect(result.fullReversal).toBe(true);
    expect(result.movements).toHaveLength(2);
    expect(result.movements.map((m) => m.skuId).sort()).toEqual(["comp-1", "comp-2"]);
    expect(result.movements.every((m) => m.qtyDelta > 0)).toBe(true);
  });

  it("devolução parcial não gera movimento nenhum — precisa de ajuste manual", () => {
    const saleMovements: ReturnedSaleMovement[] = [
      { skuId: "sku-a", qtyDelta: -5, idempotencyKey: `venda:${String(ORDER.id)}:0`, occurredAt: VENDIDO_EM },
    ];

    const result = computeReturnReversal(
      ORDER,
      { position: 0, totalQuantity: 5, returnQuantity: 2 },
      saleMovements,
      [],
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
      [{ skuId: "sku-a", qtyDelta: -4, idempotencyKey: `venda:${String(ORDER.id)}:0`, occurredAt: VENDIDO_EM }],
      [],
      CLAIM_ID,
      OCCURRED_AT,
    );

    expect(result.event.eventType).toBe("order.returned");
    expect(result.event.severity).toBe("importante");
    expect(result.event.dedupKey).toBe(`order.returned:${CLAIM_ID}:0`);
  });

  it("reprocessar o mesmo claim produz as mesmas chaves — idempotente", () => {
    const saleMovements: ReturnedSaleMovement[] = [
      { skuId: "sku-a", qtyDelta: -3, idempotencyKey: `venda:${String(ORDER.id)}:0`, occurredAt: VENDIDO_EM },
    ];

    const first = computeReturnReversal(
      ORDER,
      { position: 0, totalQuantity: 3, returnQuantity: 3 },
      saleMovements,
      [],
      CLAIM_ID,
      OCCURRED_AT,
    );
    const second = computeReturnReversal(
      ORDER,
      { position: 0, totalQuantity: 3, returnQuantity: 3 },
      saleMovements,
      [],
      CLAIM_ID,
      OCCURRED_AT,
    );

    expect(first.movements[0]?.idempotencyKey).toBe(second.movements[0]?.idempotencyKey);
    expect(first.event.dedupKey).toBe(second.event.dedupKey);
  });
});

/**
 * Verificação de e6fda07, ALTA-1: cancelamento e devolução revertem a MESMA
 * venda, e a unidade volta ao estoque no máximo uma vez.
 */
describe("computeReturnReversal — limitada pelo que já foi revertido", () => {
  const VENDA = `venda:${String(ORDER.id)}:0`;
  const SALE: ReturnedSaleMovement[] = [{ skuId: "sku-a", qtyDelta: -1, idempotencyKey: VENDA, occurredAt: VENDIDO_EM }];
  const TOTAL = { position: 0, totalQuantity: 1, returnQuantity: 1 };

  it("o cancelamento já devolveu a venda inteira: nenhum movimento, e o evento registra a venda já revertida", () => {
    const result = computeReturnReversal(ORDER, TOTAL, SALE, [{ idempotencyKey: `cancelamento:${VENDA}`, quantity: 1, occurredAt: REVERTIDO_EM }], CLAIM_ID, OCCURRED_AT);

    expect(result.fullReversal).toBe(true);
    expect(result.movements).toEqual([]);
    expect(result.alreadyReversed).toEqual([VENDA]);
    expect(result.event.after).toMatchObject({ movementsReversed: 0, movementsAlreadyReversed: 1, needsManualReview: false });
  });

  it("cancelamento parcial antes: a devolução reverte só o restante", () => {
    const result = computeReturnReversal(
      ORDER,
      { position: 0, totalQuantity: 3, returnQuantity: 3 },
      [{ skuId: "sku-a", qtyDelta: -3, idempotencyKey: VENDA, occurredAt: VENDIDO_EM }],
      [{ idempotencyKey: `cancelamento:${VENDA}`, quantity: 1, occurredAt: REVERTIDO_EM }],
      CLAIM_ID,
      OCCURRED_AT,
    );

    expect(result.movements).toEqual([
      { skuId: "sku-a", qtyDelta: 2, idempotencyKey: `devolucao:${CLAIM_ID}:${VENDA}`, occurredAt: OCCURRED_AT },
    ]);
  });

  it("reprocessar a MESMA devolução já gravada: a própria linha fica fora da soma e o movimento sai igual", () => {
    const result = computeReturnReversal(ORDER, TOTAL, SALE, [{ idempotencyKey: `devolucao:${CLAIM_ID}:${VENDA}`, quantity: 1, occurredAt: REVERTIDO_EM }], CLAIM_ID, OCCURRED_AT);

    expect(result.movements.map((m) => [m.idempotencyKey, m.qtyDelta])).toEqual([[`devolucao:${CLAIM_ID}:${VENDA}`, 1]]);
    expect(result.alreadyReversed).toEqual([]);
  });

  it("OUTRA devolução (outro claim) já devolveu a venda: nada", () => {
    const result = computeReturnReversal(ORDER, TOTAL, SALE, [{ idempotencyKey: `devolucao:999:${VENDA}`, quantity: 1, occurredAt: REVERTIDO_EM }], CLAIM_ID, OCCURRED_AT);

    expect(result.movements).toEqual([]);
  });

  it("KIT: o limite é por componente — o cancelado não volta, o outro volta", () => {
    const result = computeReturnReversal(
      ORDER,
      { position: 1, totalQuantity: 1, returnQuantity: 1 },
      [
        { skuId: "comp-1", qtyDelta: -2, idempotencyKey: `venda:${String(ORDER.id)}:1:comp-1`, occurredAt: VENDIDO_EM },
        { skuId: "comp-2", qtyDelta: -1, idempotencyKey: `venda:${String(ORDER.id)}:1:comp-2`, occurredAt: VENDIDO_EM },
      ],
      [{ idempotencyKey: `cancelamento:venda:${String(ORDER.id)}:1:comp-1`, quantity: 2, occurredAt: REVERTIDO_EM }],
      CLAIM_ID,
      OCCURRED_AT,
    );

    expect(result.movements.map((m) => [m.skuId, m.qtyDelta])).toEqual([["comp-2", 1]]);
    expect(result.alreadyReversed).toEqual([`venda:${String(ORDER.id)}:1:comp-1`]);
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

/**
 * D-352 — devolucao de pedido entregue pelo Full nao repoe a loja.
 *
 * O produto volta para o galpao do Mercado Livre, nao para a prateleira daqui.
 * O saldo LOCAL nunca perdeu a unidade, entao repor seria somar uma unidade que
 * a loja nao tem — o defeito da fatia com o sinal trocado.
 */
describe("computeReturnReversal — pedido do Full (D-352)", () => {
  const PEDIDO_FULL = { id: ORDER.id, logisticType: "fulfillment" };
  const VENDA = `venda:${String(ORDER.id)}:0`;
  const SALE: ReturnedSaleMovement[] = [
    { skuId: "sku-a", qtyDelta: -1, idempotencyKey: VENDA, occurredAt: VENDIDO_EM },
  ];
  const TOTAL = { position: 0, totalQuantity: 1, returnQuantity: 1 };

  it("devolucao TOTAL: nenhum DEVOLUCAO_ML, e o ESTORNO_FULL que faltava a venda", () => {
    const result = computeReturnReversal(PEDIDO_FULL, TOTAL, SALE, [], CLAIM_ID, OCCURRED_AT);

    expect(result.movements).toEqual([]);
    expect(result.estornosFull).toEqual([
      { skuId: "sku-a", qtyDelta: 1, idempotencyKey: `estorno:${VENDA}`, occurredAt: VENDIDO_EM },
    ]);
    // -1 (venda gravada) +1 (estorno) = 0.
    expect((SALE[0]?.qtyDelta ?? 0) + (result.estornosFull[0]?.qtyDelta ?? 0)).toBe(0);
  });

  it("venda JA estornada: nada sai — nem reversao, nem um segundo estorno", () => {
    const result = computeReturnReversal(
      PEDIDO_FULL,
      TOTAL,
      SALE,
      [],
      CLAIM_ID,
      OCCURRED_AT,
      new Set(),
      new Set([VENDA]),
    );

    expect(result.movements).toEqual([]);
    expect(result.estornosFull).toEqual([]);
  });

  it("devolucao PARCIAL de pedido do Full: nada, e sem pedir gente — nao ha saldo da loja a ajustar", () => {
    const result = computeReturnReversal(
      PEDIDO_FULL,
      { position: 0, totalQuantity: 5, returnQuantity: 2 },
      [{ skuId: "sku-a", qtyDelta: -5, idempotencyKey: VENDA, occurredAt: VENDIDO_EM }],
      [],
      CLAIM_ID,
      OCCURRED_AT,
    );

    expect(result.movements).toEqual([]);
    expect(result.fullReversal).toBe(false);
    expect(result.event.after).toMatchObject({ needsManualReview: false, fullLogistic: true, movementsEstornoFull: 1 });
  });

  it("contraprova: a MESMA devolucao parcial fora do Full continua pedindo gente", () => {
    const result = computeReturnReversal(
      { id: ORDER.id, logisticType: "cross_docking" },
      { position: 0, totalQuantity: 5, returnQuantity: 2 },
      [{ skuId: "sku-a", qtyDelta: -5, idempotencyKey: VENDA, occurredAt: VENDIDO_EM }],
      [],
      CLAIM_ID,
      OCCURRED_AT,
    );

    expect(result.event.after).toMatchObject({ needsManualReview: true, fullLogistic: false, movementsEstornoFull: 0 });
  });

  it("KIT do Full: um ESTORNO_FULL por componente da posicao, nenhum de outra posicao", () => {
    const result = computeReturnReversal(
      PEDIDO_FULL,
      { position: 1, totalQuantity: 2, returnQuantity: 2 },
      [
        { skuId: "comp-1", qtyDelta: -6, idempotencyKey: `venda:${String(ORDER.id)}:1:comp-1`, occurredAt: VENDIDO_EM },
        { skuId: "comp-2", qtyDelta: -2, idempotencyKey: `venda:${String(ORDER.id)}:1:comp-2`, occurredAt: VENDIDO_EM },
        { skuId: "sku-outra-posicao", qtyDelta: -1, idempotencyKey: VENDA, occurredAt: VENDIDO_EM },
      ],
      [],
      CLAIM_ID,
      OCCURRED_AT,
    );

    expect(result.estornosFull.map((m) => [m.skuId, m.qtyDelta])).toEqual([
      ["comp-1", 6],
      ["comp-2", 2],
    ]);
    expect(result.movements).toEqual([]);
  });

  it("CANCELAMENTO_ML gravado antes do sinal: a devolucao anula a reversao inteira junto com o estorno", () => {
    const result = computeReturnReversal(
      PEDIDO_FULL,
      TOTAL,
      SALE,
      [{ idempotencyKey: `cancelamento:${VENDA}`, quantity: 1, occurredAt: REVERTIDO_EM }],
      CLAIM_ID,
      OCCURRED_AT,
    );

    expect(result.estornosFull).toHaveLength(1);
    expect(result.excessReversalEstornos).toEqual([
      { skuId: "sku-a", qtyDelta: -1, idempotencyKey: `estorno:cancelamento:${VENDA}`, occurredAt: REVERTIDO_EM },
    ]);
    // -1 (venda) +1 (cancelamento gravado) +1 (estorno) -1 (anulacao) = 0.
    expect(-1 + 1 + (result.estornosFull[0]?.qtyDelta ?? 0) + (result.excessReversalEstornos[0]?.qtyDelta ?? 0)).toBe(0);
  });

  it("nenhuma venda gravada da posicao: nada a estornar — nao inventa par", () => {
    const result = computeReturnReversal(PEDIDO_FULL, TOTAL, [], [], CLAIM_ID, OCCURRED_AT);

    expect(result.estornosFull).toEqual([]);
    expect(result.movements).toEqual([]);
  });
});
