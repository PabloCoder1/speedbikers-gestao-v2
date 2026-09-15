import { describe, expect, it } from "vitest";

import { computeCancellationMovements, computeCancellationReversals } from "./cancellation-reversal.js";
import type {
  CancellationMovementsInput,
  CancellationPreCapture,
  CancellationReversalOrder,
  RecordedSaleMovement,
} from "./cancellation-reversal.js";
import type { ErpCutoff, RecordedSale } from "./sale-deduction.js";

const OCCURRED_AT = new Date("2026-08-22T13:00:00.000Z");
const IMPORTADO_EM = new Date("2026-09-14T18:44:19.000Z");

function baseOrder(overrides: Partial<CancellationReversalOrder> = {}): CancellationReversalOrder {
  return {
    id: 9900001001,
    status: "cancelled",
    occurredAt: OCCURRED_AT,
    occurredAtKnown: true,
    ...overrides,
  };
}

function corte(capturedAt: Date, importedAt: Date = IMPORTADO_EM): ErpCutoff {
  return { capturedAt, importedAt };
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
    return { estornadas: new Set(["venda:9900001001:0"]), cutoffFor: () => (cutoff === null ? null : corte(cutoff)) };
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
    const outraEstornada: CancellationPreCapture = {
      estornadas: new Set(["venda:outra:0"]),
      cutoffFor: () => corte(CORTE),
    };

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
      cutoffFor: () => corte(CORTE),
    });

    expect(result.map((r) => r.skuId)).toEqual(["sku-b"]);
  });
});

describe("computeCancellationMovements — o que o pedido cancelado grava (D-351)", () => {
  const CORTE = new Date("2026-09-14T18:42:00.000Z");
  /** Venda de 09-02, anterior à planilha: pedido 2000018254475382 de produção. */
  const FECHADO = new Date("2026-09-02T23:49:20.000Z");
  const CANCELADO = new Date("2026-09-14T18:47:13.000Z");
  const PEDIDO = 2000018254475382;
  const VENDA = `venda:${String(PEDIDO)}:0`;

  function entrada(overrides: Partial<CancellationMovementsInput> = {}): CancellationMovementsInput {
    return {
      order: {
        id: PEDIDO,
        status: "cancelled",
        dateCreated: new Date("2026-09-02T23:40:00.000Z"),
        dateClosed: FECHADO,
        items: [{ position: 0, quantity: 1, skuId: "sku-a", skuKind: "PRODUTO", components: [] }],
      },
      occurredAt: CANCELADO,
      occurredAtKnown: true,
      transition: { saleStatus: "paid", cancelledAt: CANCELADO },
      recordedSales: [],
      estornadas: new Set(),
      cutoffFor: () => corte(CORTE),
      ...overrides,
    };
  }

  function tipos(resultado: ReturnType<typeof computeCancellationMovements>): string[] {
    return [
      ...resultado.sales.map((m) => `VENDA ${m.idempotencyKey} ${String(m.qtyDelta)}`),
      ...resultado.estornos.map((m) => `ESTORNO ${m.idempotencyKey} ${String(m.qtyDelta)}`),
      ...resultado.reversals.map((m) => `CANCELAMENTO ${m.idempotencyKey} ${String(m.qtyDelta)}`),
    ];
  }

  it("venda anterior ao corte, NUNCA gravada, cancelada depois dele: grava venda + estorno + cancelamento (ALTA-2)", () => {
    const resultado = computeCancellationMovements(entrada());

    expect(resultado).toEqual({
      sales: [{ skuId: "sku-a", qtyDelta: -1, idempotencyKey: VENDA, occurredAt: FECHADO }],
      estornos: [{ skuId: "sku-a", qtyDelta: 1, idempotencyKey: `estorno:${VENDA}`, occurredAt: FECHADO }],
      reversals: [{ skuId: "sku-a", qtyDelta: 1, idempotencyKey: `cancelamento:${VENDA}`, occurredAt: CANCELADO }],
    });
  });

  it("sem transição de venda observada (o backfill já trouxe cancelado): não grava nada", () => {
    expect(tipos(computeCancellationMovements(entrada({ transition: null })))).toEqual([]);
  });

  it("transição de status que não é venda válida (confirmed -> cancelled): não grava nada", () => {
    expect(tipos(computeCancellationMovements(entrada({ transition: { saleStatus: "confirmed", cancelledAt: CANCELADO } })))).toEqual(
      [],
    );
  });

  it("cancelada ATÉ o corte: não grava nada — a planilha já tem a venda e a devolução", () => {
    expect(tipos(computeCancellationMovements(entrada({ transition: { saleStatus: "paid", cancelledAt: CORTE } })))).toEqual([]);
  });

  it("instante do cancelamento desconhecido: não grava nada — não dá para afirmar que foi depois do corte", () => {
    expect(tipos(computeCancellationMovements(entrada({ transition: { saleStatus: "paid", cancelledAt: null } })))).toEqual([]);
  });

  it("venda DEPOIS do corte, nunca gravada e cancelada: não grava nada — soma zero de verdade", () => {
    const depois = entrada();

    expect(
      tipos(
        computeCancellationMovements({
          ...depois,
          order: { ...depois.order, dateClosed: new Date("2026-09-14T18:43:57.000Z") },
        }),
      ),
    ).toEqual([]);
  });

  it("sem date_closed: não grava nada — a criação não prova quando a venda foi confirmada", () => {
    const semFechamento = entrada();

    expect(tipos(computeCancellationMovements({ ...semFechamento, order: { ...semFechamento.order, dateClosed: null } }))).toEqual([]);
  });

  it("organização sem snapshot: não grava nada", () => {
    expect(tipos(computeCancellationMovements(entrada({ cutoffFor: () => null })))).toEqual([]);
  });

  it("KIT: o trio sai por componente, com a quantidade do componente", () => {
    const kit = entrada();
    const resultado = computeCancellationMovements({
      ...kit,
      order: {
        ...kit.order,
        items: [
          {
            position: 0,
            quantity: 1,
            skuId: "sku-kit",
            skuKind: "KIT",
            components: [
              { componentSkuId: "sku-a", quantity: 1 },
              { componentSkuId: "sku-b", quantity: 1 },
            ],
          },
        ],
      },
    });

    expect(tipos(resultado)).toEqual([
      `VENDA ${VENDA}:sku-a -1`,
      `VENDA ${VENDA}:sku-b -1`,
      `ESTORNO estorno:${VENDA}:sku-a 1`,
      `ESTORNO estorno:${VENDA}:sku-b 1`,
      `CANCELAMENTO cancelamento:${VENDA}:sku-a 1`,
      `CANCELAMENTO cancelamento:${VENDA}:sku-b 1`,
    ]);
  });

  describe("venda JÁ gravada", () => {
    function gravada(recordedAt: Date): (RecordedSaleMovement & RecordedSale)[] {
      return [{ skuId: "sku-a", qtyDelta: -1, idempotencyKey: VENDA, occurredAt: FECHADO, recordedAt }];
    }

    it("gravada depois do import e sem estorno (o estorno falhou antes do retry): grava o estorno E o cancelamento, nunca a venda de novo", () => {
      const resultado = computeCancellationMovements(
        entrada({ transition: null, recordedSales: gravada(new Date("2026-09-14T18:47:14.000Z")) }),
      );

      expect(tipos(resultado)).toEqual([`ESTORNO estorno:${VENDA} 1`, `CANCELAMENTO cancelamento:${VENDA} 1`]);
    });

    it("gravada ANTES do import (legítima quando entrou): só o cancelamento", () => {
      const resultado = computeCancellationMovements(
        entrada({ transition: null, recordedSales: gravada(new Date("2026-09-14T18:00:00.000Z")) }),
      );

      expect(tipos(resultado)).toEqual([`CANCELAMENTO cancelamento:${VENDA} 1`]);
    });

    it("já estornada e cancelada até o corte: nada", () => {
      const resultado = computeCancellationMovements(
        entrada({
          transition: null,
          occurredAt: CORTE,
          recordedSales: gravada(new Date("2026-09-14T18:47:14.000Z")),
          estornadas: new Set([VENDA]),
        }),
      );

      expect(tipos(resultado)).toEqual([]);
    });

    it("com a transição observada, a venda gravada não é gravada de novo", () => {
      const resultado = computeCancellationMovements(
        entrada({ recordedSales: gravada(new Date("2026-09-14T18:47:14.000Z")), estornadas: new Set([VENDA]) }),
      );

      expect(tipos(resultado)).toEqual([`CANCELAMENTO cancelamento:${VENDA} 1`]);
    });
  });

  it("pedido que não está cancelado: nada", () => {
    const pago = entrada();

    expect(tipos(computeCancellationMovements({ ...pago, order: { ...pago.order, status: "paid" } }))).toEqual([]);
  });
});
