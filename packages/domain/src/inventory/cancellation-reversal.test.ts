import { describe, expect, it } from "vitest";

import { computeCancellationReversals } from "./cancellation-reversal.js";
import type {
  CancellationPreCapture,
  CancellationReversalOrder,
  RecordedSaleMovement,
} from "./cancellation-reversal.js";

const OCCURRED_AT = new Date("2026-08-22T13:00:00.000Z");

function baseOrder(overrides: Partial<CancellationReversalOrder> = {}): CancellationReversalOrder {
  return {
    id: 9900001001,
    status: "cancelled",
    occurredAt: OCCURRED_AT,
    occurredAtKnown: true,
    ...overrides,
  };
}

const SALE_MOVEMENTS: RecordedSaleMovement[] = [
  { skuId: "sku-parafuso", qtyDelta: -3, idempotencyKey: "venda:9900001001:0" },
];

/** Nenhuma venda estornada: o comportamento de antes de D-351. */
const SEM_ESTORNO: CancellationPreCapture = {
  estornadas: new Set(),
  cutoffFor: () => {
    throw new Error("não deveria ler corte de venda sem estorno");
  },
};

describe("computeCancellationReversals", () => {
  it.each(["paid", "partially_refunded", "confirmed", "payment_required", "invalid"])(
    "status %s não reverte nada, mesmo com movimentos de venda gravados",
    (status) => {
      const order = baseOrder({ status });

      expect(computeCancellationReversals(order, SALE_MOVEMENTS, SEM_ESTORNO)).toEqual([]);
    },
  );

  it.each(["cancelled", "pending_cancel"])("reverte cada movimento VENDA_ML com quantidade invertida (%s)", (status) => {
    const order = baseOrder({ status });

    expect(computeCancellationReversals(order, SALE_MOVEMENTS, SEM_ESTORNO)).toEqual([
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

    const result = computeCancellationReversals(baseOrder(), kitMovements, SEM_ESTORNO);

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
    expect(computeCancellationReversals(baseOrder(), [], SEM_ESTORNO)).toEqual([]);
  });

  it("chave de idempotência é determinística — reprocessar o mesmo cancelamento produz a MESMA chave", () => {
    const first = computeCancellationReversals(baseOrder(), SALE_MOVEMENTS, SEM_ESTORNO);
    const second = computeCancellationReversals(baseOrder(), SALE_MOVEMENTS, SEM_ESTORNO);

    expect(first[0]?.idempotencyKey).toBe(second[0]?.idempotencyKey);
  });
});

describe("computeCancellationReversals — venda estornada por ser anterior ao snapshot (D-351)", () => {
  const CORTE = new Date("2026-09-14T18:42:00.000Z");

  function estornada(cutoff: Date | null = CORTE): CancellationPreCapture {
    return { estornadas: new Set(["venda:9900001001:0"]), cutoffFor: () => cutoff };
  }

  it("cancelada DEPOIS do corte: reverte — o UpSeller devolveu a unidade depois da planilha", () => {
    const order = baseOrder({ occurredAt: new Date("2026-09-14T19:07:45.000Z") });

    expect(computeCancellationReversals(order, SALE_MOVEMENTS, estornada())).toEqual([
      expect.objectContaining({ idempotencyKey: "cancelamento:venda:9900001001:0", qtyDelta: 3 }),
    ]);
  });

  it("cancelada ANTES do corte: não reverte — a planilha já tinha a unidade de volta", () => {
    const order = baseOrder({ occurredAt: new Date("2026-09-14T18:30:00.000Z") });

    expect(computeCancellationReversals(order, SALE_MOVEMENTS, estornada())).toEqual([]);
  });

  it("cancelada EXATAMENTE no corte: não reverte — a mesma fronteira do gate da venda", () => {
    expect(computeCancellationReversals(baseOrder({ occurredAt: CORTE }), SALE_MOVEMENTS, estornada())).toEqual([]);
  });

  it("instante do cancelamento desconhecido (caiu em date_created): reverte", () => {
    const order = baseOrder({ occurredAt: new Date("2026-09-10T00:00:00.000Z"), occurredAtKnown: false });

    expect(computeCancellationReversals(order, SALE_MOVEMENTS, estornada())).toHaveLength(1);
  });

  it("venda SEM estorno cancelada antes do corte: reverte — ela nunca foi anulada", () => {
    const order = baseOrder({ occurredAt: new Date("2026-09-14T18:30:00.000Z") });
    const outraEstornada: CancellationPreCapture = { estornadas: new Set(["venda:outra:0"]), cutoffFor: () => CORTE };

    expect(computeCancellationReversals(order, SALE_MOVEMENTS, outraEstornada)).toHaveLength(1);
  });

  it("KIT com um componente estornado e outro não: pula só o estornado", () => {
    const kit: RecordedSaleMovement[] = [
      { skuId: "sku-a", qtyDelta: -1, idempotencyKey: "venda:9900001001:0:sku-a" },
      { skuId: "sku-b", qtyDelta: -2, idempotencyKey: "venda:9900001001:0:sku-b" },
    ];
    const order = baseOrder({ occurredAt: new Date("2026-09-14T18:30:00.000Z") });

    const result = computeCancellationReversals(order, kit, {
      estornadas: new Set(["venda:9900001001:0:sku-a"]),
      cutoffFor: () => CORTE,
    });

    expect(result.map((r) => r.skuId)).toEqual(["sku-b"]);
  });
});
