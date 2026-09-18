import { describe, expect, it } from "vitest";

import { cancelledInSheetKeys, computeCancellationMovements, computeCancellationReversals } from "./cancellation-reversal.js";
import type {
  CancellationMovementsInput,
  CancellationPreCapture,
  CancellationReversalOrder,
  RecordedSaleMovement,
} from "./cancellation-reversal.js";
import { computeReturnReversal } from "./return-reversal.js";
import type { TimedRecordedReversal } from "./reversal-limit.js";
import { computeSaleDeductions } from "./sale-deduction.js";
import type { ErpCutoff, RecordedSale, StockMovementDraft } from "./sale-deduction.js";

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

function corte(capturedAt: Date, importedAt: Date = IMPORTADO_EM, exportedAt: Date = capturedAt): ErpCutoff {
  return { capturedAt, importedAt, reconciledAt: null, exportedAt };
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
  reversals: [],
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
    return {
      estornadas: new Set(["venda:9900001001:0"]),
      cutoffFor: () => (cutoff === null ? null : corte(cutoff)),
      reversals: [],
    };
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
      reversals: [],
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
      reversals: [],
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
        logisticType: null,
        items: [{ position: 0, quantity: 1, skuId: "sku-a", skuKind: "PRODUTO", components: [] }],
      },
      occurredAt: CANCELADO,
      occurredAtKnown: true,
      transition: { saleStatus: "paid", cancelledAt: CANCELADO },
      recordedSales: [],
      estornadas: new Set(),
      reversals: [],
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
      estornosFull: [],
      excessReversalEstornos: [],
      reversals: [{ skuId: "sku-a", qtyDelta: 1, idempotencyKey: `cancelamento:${VENDA}`, occurredAt: CANCELADO }],
      alreadyReversed: [],
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

  it("venda fechada NO instante da exportação, nunca gravada, cancelada depois dela: grava o trio — a mesma fronteira do gate da venda (reverificação de 60c7a6a, MÉDIA-1)", () => {
    const noCorte = entrada();
    const order = { ...noCorte.order, dateClosed: CORTE };

    expect(computeCancellationMovements({ ...noCorte, order })).toEqual({
      sales: [{ skuId: "sku-a", qtyDelta: -1, idempotencyKey: VENDA, occurredAt: CORTE }],
      estornos: [{ skuId: "sku-a", qtyDelta: 1, idempotencyKey: `estorno:${VENDA}`, occurredAt: CORTE }],
      estornosFull: [],
      excessReversalEstornos: [],
      reversals: [{ skuId: "sku-a", qtyDelta: 1, idempotencyKey: `cancelamento:${VENDA}`, occurredAt: CANCELADO }],
      alreadyReversed: [],
    });

    // O gate da venda trata a MESMA venda como incluída na planilha (`<=`): os dois lados concordam.
    const gate = computeSaleDeductions(
      { ...order, status: "paid" },
      { cutoffFor: () => corte(CORTE), recordedSale: () => undefined, recordedReversals: [] },
    );

    expect(gate.preCaptureReversals).toHaveLength(1);
    // 1 ms depois da exportação, a planilha não tem a venda: o trio não sai.
    expect(tipos(computeCancellationMovements({ ...noCorte, order: { ...order, dateClosed: new Date(CORTE.getTime() + 1) } }))).toEqual(
      [],
    );
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

/**
 * Verificação de e6fda07 — os achados sobre o cancelamento:
 *
 *  - ALTA-1: cancelamento e devolução revertem a MESMA venda; a unidade volta ao
 *    estoque no máximo uma vez.
 *  - MÉDIA-1 (bateria): o trio decidia "venda nunca gravada" pela chave de hoje.
 *  - MÉDIA-2 (bateria): o estorno gerado no próprio cancelamento contando como
 *    estornado não tinha teste.
 *  - BAIXA-1 (cancelamento): o CANCELAMENTO_ML do trio com o instante desta
 *    leitura desconhecido.
 */
describe("computeCancellationMovements — verificação de e6fda07", () => {
  const CORTE = new Date("2026-09-14T18:42:00.000Z");
  const IMPORT = new Date("2026-09-14T18:44:19.581Z");
  const PEDIDO = 2000018212899604;
  const VENDA = `venda:${String(PEDIDO)}:0`;
  const CLAIM = "5570995770";

  function entrada(overrides: Partial<CancellationMovementsInput> = {}): CancellationMovementsInput {
    return {
      order: {
        id: PEDIDO,
        status: "cancelled",
        dateCreated: new Date("2026-08-31T21:00:00.000Z"),
        dateClosed: new Date("2026-08-31T21:05:29.000Z"),
        logisticType: null,
        items: [{ position: 0, quantity: 1, skuId: "sku-a", skuKind: "PRODUTO", components: [] }],
      },
      occurredAt: new Date("2026-09-15T08:40:07.000Z"),
      occurredAtKnown: true,
      transition: null,
      recordedSales: [],
      estornadas: new Set(),
      reversals: [],
      cutoffFor: () => ({ capturedAt: CORTE, importedAt: IMPORT, reconciledAt: null, exportedAt: CORTE }),
      ...overrides,
    };
  }

  /** O líquido do pedido no saldo: venda + estorno + cancelamento + devolução. */
  function liquido(...listas: (readonly StockMovementDraft[])[]): number {
    return listas.flat().reduce((soma, m) => soma + m.qtyDelta, 0);
  }

  function comoReversao(drafts: readonly StockMovementDraft[]): TimedRecordedReversal[] {
    return drafts.map((d) => ({ idempotencyKey: d.idempotencyKey, quantity: d.qtyDelta, occurredAt: d.occurredAt }));
  }

  const DEVOLVIDA_EM = new Date("2026-09-15T08:39:04.000Z");

  describe("ALTA-1: o limite das reversões", () => {
    // Venda legítima (fechada depois do corte), para isolar o limite do estorno.
    const LEGITIMA: (RecordedSaleMovement & RecordedSale)[] = [
      {
        skuId: "sku-a",
        qtyDelta: -1,
        idempotencyKey: VENDA,
        occurredAt: new Date("2026-09-15T01:00:00.000Z"),
        recordedAt: new Date("2026-09-15T01:00:03.000Z"),
      },
    ];
    const DEPOIS_DO_CORTE = { ...entrada().order, dateClosed: new Date("2026-09-15T01:00:00.000Z") };

    it("a devolução entregue já devolveu a venda inteira: o cancelamento não grava nada e registra a venda como já revertida", () => {
      const resultado = computeCancellationMovements(
        entrada({
          order: DEPOIS_DO_CORTE,
          recordedSales: LEGITIMA,
          reversals: [{ idempotencyKey: `devolucao:${CLAIM}:${VENDA}`, quantity: 1, occurredAt: DEVOLVIDA_EM }],
        }),
      );

      expect(resultado.reversals).toEqual([]);
      expect(resultado.alreadyReversed).toEqual([VENDA]);
    });

    it("devolução parcial antes: o cancelamento reverte só o restante", () => {
      const tres = [{ ...LEGITIMA[0], qtyDelta: -3 } as RecordedSaleMovement & RecordedSale];
      const resultado = computeCancellationMovements(
        entrada({
          order: DEPOIS_DO_CORTE,
          recordedSales: tres,
          reversals: [{ idempotencyKey: `devolucao:${CLAIM}:${VENDA}`, quantity: 1, occurredAt: DEVOLVIDA_EM }],
        }),
      );

      expect(resultado.reversals.map((r) => [r.idempotencyKey, r.qtyDelta])).toEqual([[`cancelamento:${VENDA}`, 2]]);
    });

    it("reprocessar o cancelamento já gravado: a própria linha fica fora da soma e o movimento sai igual (o UNIQUE absorve)", () => {
      const resultado = computeCancellationMovements(
        entrada({
          order: DEPOIS_DO_CORTE,
          recordedSales: LEGITIMA,
          reversals: [{ idempotencyKey: `cancelamento:${VENDA}`, quantity: 1, occurredAt: new Date("2026-09-15T08:40:07.000Z") }],
        }),
      );

      expect(resultado.reversals.map((r) => [r.idempotencyKey, r.qtyDelta])).toEqual([[`cancelamento:${VENDA}`, 1]]);
      expect(resultado.alreadyReversed).toEqual([]);
    });

    it("2000018212899604 de produção (VENDA do worker antigo + DEVOLUCAO + CANCELAMENTO): o estorno da venda inteira e a anulação do cancelamento, a reversão a mais — o líquido fica +1 (D-351 §12)", () => {
      const gravada: (RecordedSaleMovement & RecordedSale)[] = [
        {
          skuId: "sku-a",
          qtyDelta: -1,
          idempotencyKey: VENDA,
          occurredAt: new Date("2026-09-15T01:50:58.000Z"),
          recordedAt: new Date("2026-09-15T02:00:05.948Z"),
        },
      ];
      const reversals: TimedRecordedReversal[] = [
        { idempotencyKey: `devolucao:${CLAIM}:${VENDA}`, quantity: 1, occurredAt: DEVOLVIDA_EM },
        { idempotencyKey: `cancelamento:${VENDA}`, quantity: 1, occurredAt: new Date("2026-09-15T08:40:07.000Z") },
      ];

      const resultado = computeCancellationMovements(entrada({ recordedSales: gravada, reversals }));

      expect(resultado.estornos).toEqual([
        { skuId: "sku-a", qtyDelta: 1, idempotencyKey: `estorno:${VENDA}`, occurredAt: new Date("2026-09-15T01:50:58.000Z") },
      ]);
      expect(resultado.excessReversalEstornos).toEqual([
        { skuId: "sku-a", qtyDelta: -1, idempotencyKey: `estorno:cancelamento:${VENDA}`, occurredAt: new Date("2026-09-15T08:40:07.000Z") },
      ]);
      // O cancelamento já gravado sai de novo (o UNIQUE absorve)? Não: a devolução já devolveu a unidade.
      expect(resultado.reversals).toEqual([]);
      expect(resultado.alreadyReversed).toEqual([VENDA]);
      // Ledger do pedido: -1 (venda) +1 (devolução) +1 (cancelamento) +1 (estorno) -1 (anulação) = +1, igual ao real.
      expect(-1 + 1 + 1 + liquido(resultado.sales, resultado.estornos, resultado.excessReversalEstornos, resultado.reversals)).toBe(1);
    });

    it("trio seguido da devolução entregue: a devolução não devolve a unidade de novo — líquido +1", () => {
      const trio = computeCancellationMovements(
        entrada({ transition: { saleStatus: "paid", cancelledAt: new Date("2026-09-15T01:36:10.000Z") } }),
      );

      expect(trio.sales).toHaveLength(1);

      const devolucao = computeReturnReversal(
        { id: PEDIDO, logisticType: null },
        { position: 0, totalQuantity: 1, returnQuantity: 1 },
        trio.sales,
        comoReversao(trio.reversals),
        CLAIM,
        new Date("2026-09-15T09:00:00.000Z"),
      );

      expect(devolucao.movements).toEqual([]);
      expect(devolucao.alreadyReversed).toEqual([VENDA]);
      expect(liquido(trio.sales, trio.estornos, trio.reversals, devolucao.movements)).toBe(1);
    });

    it("o inverso: devolução entregue primeiro, cancelamento depois — o cancelamento não devolve de novo", () => {
      const devolucao = computeReturnReversal(
        { id: PEDIDO, logisticType: null },
        { position: 0, totalQuantity: 1, returnQuantity: 1 },
        LEGITIMA,
        [],
        CLAIM,
        new Date("2026-09-15T08:39:04.218Z"),
      );

      expect(devolucao.movements).toHaveLength(1);

      const cancelamento = computeCancellationMovements(
        entrada({ order: DEPOIS_DO_CORTE, recordedSales: LEGITIMA, reversals: comoReversao(devolucao.movements) }),
      );

      expect(cancelamento.reversals).toEqual([]);
      // Venda legítima: -1 + a unidade que voltou uma vez = 0.
      expect(-1 + liquido(devolucao.movements, cancelamento.reversals)).toBe(0);
    });
  });

  describe("MÉDIA-1 (bateria): o trio só repõe pedido SEM nenhum VENDA_ML gravado", () => {
    const TRANSICAO = { saleStatus: "paid", cancelledAt: new Date("2026-09-15T10:00:00.000Z") };

    function gravadasDoKit(...componentes: string[]): (RecordedSaleMovement & RecordedSale)[] {
      return componentes.map((componente) => ({
        skuId: componente,
        qtyDelta: -1,
        idempotencyKey: `${VENDA}:${componente}`,
        occurredAt: new Date("2026-08-31T21:05:29.000Z"),
        recordedAt: new Date("2026-09-10T12:00:00.000Z"),
      }));
    }

    it("KIT com composição alterada (A1+A2 -> A1+B2) entre a venda e o cancelamento: só reverte o gravado, e B2 não ganha nada", () => {
      const resultado = computeCancellationMovements(
        entrada({
          order: {
            ...entrada().order,
            items: [
              {
                position: 0,
                quantity: 1,
                skuId: "sku-kit",
                skuKind: "KIT",
                components: [
                  { componentSkuId: "A1", quantity: 1 },
                  { componentSkuId: "B2", quantity: 1 },
                ],
              },
            ],
          },
          transition: TRANSICAO,
          recordedSales: gravadasDoKit("A1", "A2"),
          estornadas: new Set([`${VENDA}:A1`, `${VENDA}:A2`]),
        }),
      );

      expect(resultado.sales).toEqual([]);
      expect(resultado.estornos).toEqual([]);
      expect(resultado.reversals.map((r) => [r.skuId, r.qtyDelta])).toEqual([
        ["A1", 1],
        ["A2", 1],
      ]);
      expect([...resultado.sales, ...resultado.estornos, ...resultado.reversals].some((m) => m.skuId === "B2")).toBe(false);
    });

    it("PRODUTO P que virou KIT C1+C2: só reverte a venda de P, nada para C1 e C2", () => {
      const resultado = computeCancellationMovements(
        entrada({
          order: {
            ...entrada().order,
            items: [
              {
                position: 0,
                quantity: 1,
                skuId: "sku-kit",
                skuKind: "KIT",
                components: [
                  { componentSkuId: "C1", quantity: 1 },
                  { componentSkuId: "C2", quantity: 1 },
                ],
              },
            ],
          },
          transition: TRANSICAO,
          recordedSales: [
            {
              skuId: "P",
              qtyDelta: -1,
              idempotencyKey: VENDA,
              occurredAt: new Date("2026-08-31T21:05:29.000Z"),
              recordedAt: new Date("2026-09-10T12:00:00.000Z"),
            },
          ],
          estornadas: new Set([VENDA]),
        }),
      );

      expect([...resultado.sales, ...resultado.estornos, ...resultado.reversals].map((m) => [m.idempotencyKey, m.skuId, m.qtyDelta])).toEqual([
        [`cancelamento:${VENDA}`, "P", 1],
      ]);
    });
  });

  describe("MÉDIA-2 (bateria): o estorno gerado agora conta como estornado", () => {
    // Gravada depois do import e sem estorno (o estorno falhou antes do retry).
    const SEM_PAR: (RecordedSaleMovement & RecordedSale)[] = [
      {
        skuId: "sku-a",
        qtyDelta: -1,
        idempotencyKey: VENDA,
        occurredAt: new Date("2026-08-31T21:05:29.000Z"),
        recordedAt: new Date("2026-09-14T18:47:14.000Z"),
      },
    ];

    it.each([
      ["no corte", CORTE],
      ["antes do corte", new Date("2026-09-14T18:30:00.000Z")],
    ])("cancelamento conhecido %s: grava SÓ o ESTORNO, nenhum CANCELAMENTO_ML — líquido 0", (_rotulo, cancelado) => {
      const resultado = computeCancellationMovements(entrada({ occurredAt: cancelado, recordedSales: SEM_PAR }));

      expect(resultado.estornos.map((e) => e.idempotencyKey)).toEqual([`estorno:${VENDA}`]);
      expect(resultado.reversals).toEqual([]);
      expect(-1 + liquido(resultado.estornos, resultado.reversals)).toBe(0);
    });
  });

  describe("BAIXA-1 (cancelamento): o CANCELAMENTO_ML do trio com o instante desta leitura desconhecido", () => {
    it("leva o instante da transição (posterior ao corte), e não date_created", () => {
      const cancelado = new Date("2026-09-14T18:47:13.000Z");
      const resultado = computeCancellationMovements(
        entrada({
          occurredAt: new Date("2026-08-31T21:00:00.000Z"),
          occurredAtKnown: false,
          transition: { saleStatus: "paid", cancelledAt: cancelado },
        }),
      );

      expect(resultado.reversals.map((r) => [r.idempotencyKey, r.occurredAt])).toEqual([[`cancelamento:${VENDA}`, cancelado]]);
    });
  });
});

/**
 * Reverificação de c48fb70, MÉDIA-1: o que a planilha tem é decidido pela exportação
 * (`exportedAt`), e não pelo corte do alvo. Instantes do Dev: exportada em 08-20 16:09:23,
 * corte que a migration deixa no parse, 08-21 15:42:02.459.
 */
describe("cancelamento — a planilha retrata a exportação, e não o corte do parse (reverificação de c48fb70, MÉDIA-1)", () => {
  const EXPORTACAO = new Date("2026-08-20T16:09:23.000Z");
  const PARSE = new Date("2026-08-21T15:42:02.459Z");
  const IMPORT = new Date("2026-08-21T17:12:43.810Z");
  const NA_JANELA = new Date("2026-08-21T12:37:59.000Z");
  const PEDIDO = 2000018048056108;
  const VENDA = `venda:${String(PEDIDO)}:0`;
  const DO_DEV = corte(PARSE, IMPORT, EXPORTACAO);

  function entrada(dateClosed: Date, cancelledAt: Date): CancellationMovementsInput {
    return {
      order: {
        id: PEDIDO,
        status: "cancelled",
        dateCreated: new Date(dateClosed.getTime() - 60_000),
        dateClosed,
        logisticType: null,
        items: [{ position: 0, quantity: 1, skuId: "sku-a", skuKind: "PRODUTO", components: [] }],
      },
      occurredAt: new Date("2026-09-15T10:00:00.000Z"),
      occurredAtKnown: true,
      transition: { saleStatus: "paid", cancelledAt },
      recordedSales: [],
      estornadas: new Set(),
      reversals: [],
      cutoffFor: () => DO_DEV,
    };
  }

  it("venda nunca gravada ENTRE a exportação e o parse, cancelada depois do corte: nada — a planilha não tem a venda, e o trio daria +1", () => {
    const resultado = computeCancellationMovements(entrada(NA_JANELA, new Date("2026-09-10T10:00:00.000Z")));

    expect(resultado).toEqual({ sales: [], estornos: [], estornosFull: [], excessReversalEstornos: [], reversals: [], alreadyReversed: [] });
  });

  it("venda antes da exportação, nunca gravada, cancelada ENTRE a exportação e o parse: o trio — a planilha tem a venda e não tem a devolução", () => {
    const resultado = computeCancellationMovements(entrada(new Date("2026-08-20T10:00:00.000Z"), NA_JANELA));

    expect(resultado.sales.map((m) => m.idempotencyKey)).toEqual([VENDA]);
    expect(resultado.estornos.map((m) => m.idempotencyKey)).toEqual([`estorno:${VENDA}`]);
    expect(resultado.reversals.map((m) => [m.idempotencyKey, m.qtyDelta])).toEqual([[`cancelamento:${VENDA}`, 1]]);
  });

  it("venda estornada cancelada ENTRE a exportação e o parse: reverte — a planilha não tem a devolução", () => {
    const estornada: CancellationPreCapture = { estornadas: new Set([VENDA]), cutoffFor: () => DO_DEV, reversals: [] };

    expect(
      computeCancellationReversals(
        baseOrder({ id: PEDIDO, occurredAt: NA_JANELA }),
        [{ skuId: "sku-a", qtyDelta: -1, idempotencyKey: VENDA }],
        estornada,
      ),
    ).toEqual([{ skuId: "sku-a", qtyDelta: 1, idempotencyKey: `cancelamento:${VENDA}`, occurredAt: NA_JANELA }]);
  });
});

/**
 * Reverificação de 60c7a6a, BAIXA-1: o cancelamento pulado de venda estornada não
 * grava nada, e a devolução entregue depois devolvia a unidade uma segunda vez.
 */
describe("a devolução depois do cancelamento que a planilha já contém (reverificação de 60c7a6a, BAIXA-1)", () => {
  // Venda de 09-10 gravada tarde (vínculo criado em 09-15) e estornada pelo corte das 18:42 de 09-14.
  // O pedido cancela em 09-16 10:00 e o UpSeller devolve a unidade; a planilha 2 é exportada às 12:00.
  const PEDIDO = 2000018300000001;
  const VENDA = `venda:${String(PEDIDO)}:0`;
  const CLAIM = "5571000001";
  const PLANILHA_2 = corte(new Date("2026-09-16T12:00:00.000Z"), new Date("2026-09-16T12:02:00.000Z"));
  const CANCELADO = new Date("2026-09-16T10:00:00.000Z");
  const DEVOLVIDO = new Date("2026-09-17T09:00:00.000Z");
  const GRAVADA: (RecordedSaleMovement & RecordedSale)[] = [
    {
      skuId: "sku-a",
      qtyDelta: -1,
      idempotencyKey: VENDA,
      occurredAt: new Date("2026-09-10T15:00:00.000Z"),
      recordedAt: new Date("2026-09-15T11:00:00.000Z"),
    },
  ];
  const ITEM = { position: 0, totalQuantity: 1, returnQuantity: 1 };
  const ESTORNADA = new Set([VENDA]);
  const NAO_ESTORNADA = new Set<string>();
  const pedido = (overrides: Partial<CancellationReversalOrder> = {}): CancellationReversalOrder =>
    baseOrder({ id: PEDIDO, occurredAt: CANCELADO, ...overrides });

  function cancelamento(estornadas: ReadonlySet<string>, occurredAt: Date = CANCELADO) {
    return computeCancellationMovements({
      order: {
        id: PEDIDO,
        status: "cancelled",
        dateCreated: new Date("2026-09-10T14:55:00.000Z"),
        dateClosed: new Date("2026-09-10T15:00:00.000Z"),
        logisticType: null,
        items: [{ position: 0, quantity: 1, skuId: "sku-a", skuKind: "PRODUTO", components: [] }],
      },
      occurredAt,
      occurredAtKnown: true,
      transition: null,
      recordedSales: GRAVADA,
      estornadas,
      reversals: [],
      cutoffFor: () => PLANILHA_2,
    });
  }

  const soma = (...listas: (readonly StockMovementDraft[])[]): number => listas.flat().reduce((total, m) => total + m.qtyDelta, 0);

  it("venda estornada cancelada até a exportação: o cancelamento pula, e a devolução entregue depois não devolve a unidade de novo", () => {
    const cancel = cancelamento(ESTORNADA);

    expect(cancel.reversals).toEqual([]);

    const naPlanilha = cancelledInSheetKeys(pedido(), GRAVADA, ESTORNADA, () => PLANILHA_2);
    const devolucao = computeReturnReversal({ id: PEDIDO, logisticType: null }, ITEM, GRAVADA, [], CLAIM, DEVOLVIDO, new Set(naPlanilha));

    expect(naPlanilha).toEqual([VENDA]);
    expect(devolucao.movements).toEqual([]);
    expect(devolucao.alreadyReversed).toEqual([VENDA]);
    expect(devolucao.event.after).toMatchObject({ movementsReversed: 0, movementsAlreadyReversed: 1, needsManualReview: false });
    // Venda -1 e estorno +1: a unidade voltou uma vez só, pela planilha 2 (real 10, saldo 10, alvo 10).
    expect(-1 + 1 + soma(cancel.reversals, devolucao.movements)).toBe(0);
  });

  it("contraprova: a venda NÃO estornada — o cancelamento reverte, e a devolução sai 0 pelo limite das reversões gravadas", () => {
    const cancel = cancelamento(NAO_ESTORNADA);

    expect(cancel.reversals.map((m) => [m.idempotencyKey, m.qtyDelta])).toEqual([[`cancelamento:${VENDA}`, 1]]);
    expect(cancelledInSheetKeys(pedido(), GRAVADA, NAO_ESTORNADA, () => PLANILHA_2)).toEqual([]);

    const devolucao = computeReturnReversal(
      { id: PEDIDO, logisticType: null },
      ITEM,
      GRAVADA,
      cancel.reversals.map((m) => ({ idempotencyKey: m.idempotencyKey, quantity: m.qtyDelta, occurredAt: m.occurredAt })),
      CLAIM,
      DEVOLVIDO,
      new Set(),
    );

    expect(devolucao.movements).toEqual([]);
    expect(-1 + soma(cancel.reversals, devolucao.movements)).toBe(0);
  });

  it("venda estornada cancelada DEPOIS da exportação: fora do conjunto — o cancelamento reverte, e a devolução que chega antes dele devolve", () => {
    const depois = new Date(PLANILHA_2.exportedAt.getTime() + 1);

    expect(cancelledInSheetKeys(pedido({ occurredAt: depois }), GRAVADA, ESTORNADA, () => PLANILHA_2)).toEqual([]);
    expect(cancelamento(ESTORNADA, depois).reversals).toHaveLength(1);
    expect(computeReturnReversal({ id: PEDIDO, logisticType: null }, ITEM, GRAVADA, [], CLAIM, DEVOLVIDO, new Set()).movements).toHaveLength(1);
  });

  it("fronteira: cancelada NO instante da exportação conta como contida, como no cancelamento", () => {
    expect(cancelledInSheetKeys(pedido({ occurredAt: PLANILHA_2.exportedAt }), GRAVADA, ESTORNADA, () => PLANILHA_2)).toEqual([VENDA]);
    expect(cancelamento(ESTORNADA, PLANILHA_2.exportedAt).reversals).toEqual([]);
  });

  it("fora do conjunto: venda NÃO estornada, instante desconhecido, pedido não cancelado e organização sem snapshot", () => {
    expect(cancelledInSheetKeys(pedido(), GRAVADA, NAO_ESTORNADA, () => PLANILHA_2)).toEqual([]);
    expect(cancelledInSheetKeys(pedido({ occurredAtKnown: false }), GRAVADA, ESTORNADA, () => PLANILHA_2)).toEqual([]);
    expect(cancelledInSheetKeys(pedido({ status: "paid" }), GRAVADA, ESTORNADA, () => PLANILHA_2)).toEqual([]);
    expect(cancelledInSheetKeys(pedido(), GRAVADA, ESTORNADA, () => null)).toEqual([]);
  });
});

/**
 * D-351 §12 (reverificação de cc90baa, F3-EXCESSO-FORA-DO-ALVO): o estorno descontava o
 * excesso de reversão do legado, e a conta só fechava com a venda e a reversão a mais do
 * mesmo lado do corte do alvo. Agora o estorno é a venda inteira, com o instante dela, e a
 * reversão a mais ganha a própria anulação, com o instante da reversão.
 */
describe("computeCancellationMovements — a reversão a mais do legado anulada com o instante dela (D-351 §12)", () => {
  const CORTE = new Date("2026-09-14T18:42:00.000Z");
  const IMPORT = new Date("2026-09-14T18:44:19.581Z");
  const CORTE_DE_PRODUCAO: ErpCutoff = { capturedAt: CORTE, importedAt: IMPORT, reconciledAt: null, exportedAt: CORTE };

  interface Linha {
    readonly qtyDelta: number;
    readonly occurredAt: Date;
  }

  /** Saldo e parte no alvo de `compute_erp_target_balances` (só `occurred_at > captured_at`). */
  function saldoEAlvo(linhas: readonly Linha[]): { saldo: number; alvo: number } {
    return {
      saldo: linhas.reduce((soma, l) => soma + l.qtyDelta, 0),
      alvo: linhas.filter((l) => l.occurredAt.getTime() > CORTE.getTime()).reduce((soma, l) => soma + l.qtyDelta, 0),
    };
  }

  describe("2000017792822486 de produção: KIT de 3 componentes, VENDA do worker antigo ATÉ o corte, devolução e cancelamento depois", () => {
    const PEDIDO = 2000017792822486;
    const COMPONENTES = ["comp-8e9f38e7", "comp-b9fdfa64", "comp-c5af7f1f"];
    const CLAIM = "5571421181";
    const VENDIDA_EM = new Date("2026-09-14T18:11:20.000Z");
    const DEVOLVIDA_EM = new Date("2026-09-16T00:12:31.170Z");
    const CANCELADA_EM = new Date("2026-09-16T12:58:04.000Z");
    const chave = (componente: string) => `venda:${String(PEDIDO)}:0:${componente}`;
    const GRAVADAS: (RecordedSaleMovement & RecordedSale)[] = COMPONENTES.map((componente) => ({
      skuId: componente,
      qtyDelta: -1,
      idempotencyKey: chave(componente),
      occurredAt: VENDIDA_EM,
      recordedAt: new Date("2026-09-14T19:00:06.564Z"),
    }));
    const REVERSOES: TimedRecordedReversal[] = COMPONENTES.flatMap((componente) => [
      { idempotencyKey: `devolucao:${CLAIM}:${chave(componente)}`, quantity: 1, occurredAt: DEVOLVIDA_EM },
      { idempotencyKey: `cancelamento:${chave(componente)}`, quantity: 1, occurredAt: CANCELADA_EM },
    ]);

    function entrada(estornadas: ReadonlySet<string> = new Set()): CancellationMovementsInput {
      return {
        order: {
          id: PEDIDO,
          status: "cancelled",
          dateCreated: new Date("2026-08-06T18:20:00.000Z"),
          dateClosed: new Date("2026-08-06T18:25:09.000Z"),
          logisticType: null,
          items: [
            {
              position: 0,
              quantity: 1,
              skuId: "kit",
              skuKind: "KIT",
              components: COMPONENTES.map((componentSkuId) => ({ componentSkuId, quantity: 1 })),
            },
          ],
        },
        occurredAt: CANCELADA_EM,
        occurredAtKnown: true,
        transition: { saleStatus: "paid", cancelledAt: CANCELADA_EM },
        recordedSales: GRAVADAS,
        estornadas,
        reversals: REVERSOES,
        cutoffFor: () => CORTE_DE_PRODUCAO,
      };
    }

    it("cada componente: o estorno da venda inteira com o instante da venda, e a anulação do cancelamento (a reversão mais recente) com o instante dele", () => {
      const resultado = computeCancellationMovements(entrada());

      expect(resultado.sales).toEqual([]);
      expect(resultado.reversals).toEqual([]);
      expect(resultado.alreadyReversed).toEqual(COMPONENTES.map(chave));
      expect(resultado.estornos).toEqual(
        COMPONENTES.map((componente) => ({ skuId: componente, qtyDelta: 1, idempotencyKey: `estorno:${chave(componente)}`, occurredAt: VENDIDA_EM })),
      );
      expect(resultado.excessReversalEstornos).toEqual(
        COMPONENTES.map((componente) => ({
          skuId: componente,
          qtyDelta: -1,
          idempotencyKey: `estorno:cancelamento:${chave(componente)}`,
          occurredAt: CANCELADA_EM,
        })),
      );
    });

    it("saldo e alvo em +1 por componente -- o real (a planilha tem a venda, e a unidade voltou uma vez); o estorno descontado dava alvo +2", () => {
      const resultado = computeCancellationMovements(entrada());

      for (const componente of COMPONENTES) {
        const gravado: Linha[] = [
          { qtyDelta: -1, occurredAt: VENDIDA_EM },
          { qtyDelta: 1, occurredAt: DEVOLVIDA_EM },
          { qtyDelta: 1, occurredAt: CANCELADA_EM },
        ];
        const novas = [...resultado.estornos, ...resultado.excessReversalEstornos, ...resultado.reversals].filter(
          (m) => m.skuId === componente,
        );

        expect(saldoEAlvo([...gravado, ...novas])).toEqual({ saldo: 1, alvo: 1 });
        // A regra de cc90baa: estorno de V - E = 0, nenhuma linha -- alvo +2.
        expect(saldoEAlvo(gravado)).toEqual({ saldo: 1, alvo: 2 });
      }
    });

    it("reprocessar com os estornos já gravados: nenhum estorno novo, e a anulação sai de novo com a MESMA chave (o UNIQUE absorve; completa o webhook que falhou entre as duas)", () => {
      const resultado = computeCancellationMovements(entrada(new Set(COMPONENTES.map(chave))));

      expect(resultado.estornos).toEqual([]);
      expect(resultado.excessReversalEstornos.map((m) => [m.idempotencyKey, m.qtyDelta, m.occurredAt])).toEqual(
        COMPONENTES.map((componente) => [`estorno:cancelamento:${chave(componente)}`, -1, CANCELADA_EM]),
      );
    });

    it("venda JÁ estornada e organização reconciliada DEPOIS da gravação (o estorno de hoje não sairia mais): a anulação sai mesmo assim -- o ramo da venda estornada não depende do estorno recalculado", () => {
      // A reconciliação depois da gravação da venda (19:00:06) a absorveria: `preCaptureEstornoOf`
      // devolve null hoje. Mas o estorno JÁ está gravado, e a reversão a mais dele segue sem anulação.
      const reconciliada: ErpCutoff = { ...CORTE_DE_PRODUCAO, reconciledAt: new Date("2026-09-17T10:30:00.000Z") };

      // A premissa: sem o estorno gravado, a mesma entrada não estorna nem anula nada.
      const semEstorno = computeCancellationMovements({ ...entrada(), cutoffFor: () => reconciliada });

      expect(semEstorno.estornos).toEqual([]);
      expect(semEstorno.excessReversalEstornos).toEqual([]);

      const resultado = computeCancellationMovements({ ...entrada(new Set(COMPONENTES.map(chave))), cutoffFor: () => reconciliada });

      expect(resultado.sales).toEqual([]);
      expect(resultado.estornos).toEqual([]);
      expect(resultado.reversals).toEqual([]);
      expect(resultado.excessReversalEstornos).toEqual(
        COMPONENTES.map((componente) => ({
          skuId: componente,
          qtyDelta: -1,
          idempotencyKey: `estorno:cancelamento:${chave(componente)}`,
          occurredAt: CANCELADA_EM,
        })),
      );
    });
  });

  describe("contraprova, 2000018206306064 de produção: VENDA do worker antigo DENTRO do alvo", () => {
    const PEDIDO = 2000018206306064;
    const VENDA = `venda:${String(PEDIDO)}:0`;
    const VENDIDA_EM = new Date("2026-09-15T01:32:27.000Z");
    const DEVOLVIDA_EM = new Date("2026-09-15T10:58:11.000Z");
    const CANCELADA_EM = new Date("2026-09-15T10:58:16.000Z");
    const GRAVADA: (RecordedSaleMovement & RecordedSale)[] = [
      { skuId: "sku-31f2cb17", qtyDelta: -1, idempotencyKey: VENDA, occurredAt: VENDIDA_EM, recordedAt: new Date("2026-09-15T02:00:05.174Z") },
    ];

    function cancelamento(reversals: TimedRecordedReversal[]) {
      return computeCancellationMovements({
        order: {
          id: PEDIDO,
          status: "cancelled",
          dateCreated: new Date("2026-08-31T15:10:00.000Z"),
          dateClosed: new Date("2026-08-31T15:15:22.000Z"),
          logisticType: null,
          items: [{ position: 0, quantity: 1, skuId: "sku-31f2cb17", skuKind: "PRODUTO", components: [] }],
        },
        occurredAt: CANCELADA_EM,
        occurredAtKnown: true,
        transition: null,
        recordedSales: GRAVADA,
        estornadas: new Set(),
        reversals,
        cutoffFor: () => CORTE_DE_PRODUCAO,
      });
    }

    it("o estorno inteiro e a anulação do cancelamento: saldo e alvo em +1, os mesmos números da regra de cc90baa", () => {
      const resultado = cancelamento([
        { idempotencyKey: `devolucao:5570000000:${VENDA}`, quantity: 1, occurredAt: DEVOLVIDA_EM },
        { idempotencyKey: `cancelamento:${VENDA}`, quantity: 1, occurredAt: CANCELADA_EM },
      ]);

      expect(resultado.estornos.map((m) => [m.idempotencyKey, m.qtyDelta, m.occurredAt])).toEqual([[`estorno:${VENDA}`, 1, VENDIDA_EM]]);
      expect(resultado.excessReversalEstornos.map((m) => [m.idempotencyKey, m.qtyDelta, m.occurredAt])).toEqual([
        [`estorno:cancelamento:${VENDA}`, -1, CANCELADA_EM],
      ]);
      expect(
        saldoEAlvo([
          { qtyDelta: -1, occurredAt: VENDIDA_EM },
          { qtyDelta: 1, occurredAt: DEVOLVIDA_EM },
          { qtyDelta: 1, occurredAt: CANCELADA_EM },
          ...resultado.estornos,
          ...resultado.excessReversalEstornos,
        ]),
      ).toEqual({ saldo: 1, alvo: 1 });
    });

    it("R < V (só a devolução): nenhuma anulação, e o estorno é a venda inteira -- nada muda", () => {
      const resultado = cancelamento([{ idempotencyKey: `devolucao:5570000000:${VENDA}`, quantity: 1, occurredAt: DEVOLVIDA_EM }]);

      expect(resultado.estornos.map((m) => m.qtyDelta)).toEqual([1]);
      expect(resultado.excessReversalEstornos).toEqual([]);
    });
  });

  it("venda dentro do alvo com as duas reversões ANTES do corte (o worker antigo gravou a venda com a data da atualização): a anulação cai fora do alvo com a reversão, e o alvo fica em 0 -- o estorno de V - E o deixava em -1", () => {
    const VENDA = "venda:2000018000000001:0";
    const VENDIDA_EM = new Date("2026-09-14T19:00:00.000Z");
    const DEVOLVIDA_EM = new Date("2026-09-14T18:00:00.000Z");
    const CANCELADA_EM = new Date("2026-09-14T18:30:00.000Z");
    const resultado = computeCancellationMovements({
      order: {
        id: 2000018000000001,
        status: "cancelled",
        dateCreated: new Date("2026-09-10T11:55:00.000Z"),
        dateClosed: new Date("2026-09-10T12:00:00.000Z"),
        logisticType: null,
        items: [{ position: 0, quantity: 1, skuId: "sku-a", skuKind: "PRODUTO", components: [] }],
      },
      occurredAt: CANCELADA_EM,
      occurredAtKnown: true,
      transition: null,
      recordedSales: [{ skuId: "sku-a", qtyDelta: -1, idempotencyKey: VENDA, occurredAt: VENDIDA_EM, recordedAt: new Date("2026-09-14T19:00:05.000Z") }],
      estornadas: new Set(),
      reversals: [
        { idempotencyKey: `devolucao:5570000009:${VENDA}`, quantity: 1, occurredAt: DEVOLVIDA_EM },
        { idempotencyKey: `cancelamento:${VENDA}`, quantity: 1, occurredAt: CANCELADA_EM },
      ],
      cutoffFor: () => CORTE_DE_PRODUCAO,
    });

    const gravado: Linha[] = [
      { qtyDelta: -1, occurredAt: VENDIDA_EM },
      { qtyDelta: 1, occurredAt: DEVOLVIDA_EM },
      { qtyDelta: 1, occurredAt: CANCELADA_EM },
    ];

    expect(resultado.excessReversalEstornos.map((m) => [m.idempotencyKey, m.qtyDelta])).toEqual([[`estorno:cancelamento:${VENDA}`, -1]]);
    // Tudo aconteceu antes da planilha: nada a somar no alvo. O saldo fica com a unidade que as
    // reversões anteriores à planilha devolveram, e a reconciliação a ajusta -- o resíduo das
    // reversões gravadas até o corte, 0 em produção.
    expect(saldoEAlvo([...gravado, ...resultado.estornos, ...resultado.excessReversalEstornos, ...resultado.reversals])).toEqual({
      saldo: 1,
      alvo: 0,
    });
    // A regra de cc90baa: estorno de V - E = 0 com o instante da venda, dentro do alvo -- alvo -1.
    expect(saldoEAlvo(gravado)).toEqual({ saldo: 1, alvo: -1 });
  });

  it("venda NÃO estornada (fechada depois do corte) com o mesmo excesso: nenhuma anulação -- o legado fora da D-351 fica como estava", () => {
    const VENDA = "venda:2000018000000002:0";
    const resultado = computeCancellationMovements({
      order: {
        id: 2000018000000002,
        status: "cancelled",
        dateCreated: new Date("2026-09-15T00:55:00.000Z"),
        dateClosed: new Date("2026-09-15T01:00:00.000Z"),
        logisticType: null,
        items: [{ position: 0, quantity: 1, skuId: "sku-a", skuKind: "PRODUTO", components: [] }],
      },
      occurredAt: new Date("2026-09-15T08:40:07.000Z"),
      occurredAtKnown: true,
      transition: null,
      recordedSales: [
        {
          skuId: "sku-a",
          qtyDelta: -1,
          idempotencyKey: VENDA,
          occurredAt: new Date("2026-09-15T01:00:00.000Z"),
          recordedAt: new Date("2026-09-15T01:00:03.000Z"),
        },
      ],
      estornadas: new Set(),
      reversals: [
        { idempotencyKey: `devolucao:5570000010:${VENDA}`, quantity: 1, occurredAt: new Date("2026-09-15T08:39:04.000Z") },
        { idempotencyKey: `cancelamento:${VENDA}`, quantity: 1, occurredAt: new Date("2026-09-15T08:40:07.000Z") },
      ],
      cutoffFor: () => CORTE_DE_PRODUCAO,
    });

    expect(resultado.estornos).toEqual([]);
    expect(resultado.excessReversalEstornos).toEqual([]);
  });
});

/**
 * D-352 — pedido entregue pelo Full: nada reverte em LOCAL.
 *
 * A unidade nunca saiu da loja, entao nunca volta para ela. O que o
 * cancelamento (e a devolucao) fazem e COMPLETAR o par da venda, nunca somar
 * uma reposicao. O invariante medido em todo teste daqui: a venda gravada mais
 * tudo o que sai soma ZERO.
 */
describe("computeCancellationMovements — pedido entregue pelo Full (D-352)", () => {
  const CORTE = new Date("2026-09-14T18:42:00.000Z");
  const FECHADO = new Date("2026-09-16T10:00:00.000Z");
  const CANCELADO = new Date("2026-09-17T11:00:00.000Z");
  const DEVOLVIDO = new Date("2026-09-18T12:00:00.000Z");
  const PEDIDO = 2000018515005942;
  const VENDA = `venda:${String(PEDIDO)}:0`;
  const CLAIM = "5298178312";
  const ITEM = { position: 0, totalQuantity: 1, returnQuantity: 1 };

  /** O `VENDA_ML` que o worker ja gravou antes de o sinal do Full chegar. */
  const GRAVADA: (RecordedSaleMovement & RecordedSale)[] = [
    { skuId: "sku-a", qtyDelta: -1, idempotencyKey: VENDA, occurredAt: FECHADO, recordedAt: FECHADO },
  ];

  function entrada(overrides: Partial<CancellationMovementsInput> = {}): CancellationMovementsInput {
    return {
      order: {
        id: PEDIDO,
        status: "cancelled",
        dateCreated: new Date("2026-09-16T09:50:00.000Z"),
        dateClosed: FECHADO,
        logisticType: "fulfillment",
        items: [{ position: 0, quantity: 1, skuId: "sku-a", skuKind: "PRODUTO", components: [] }],
      },
      occurredAt: CANCELADO,
      occurredAtKnown: true,
      transition: { saleStatus: "paid", cancelledAt: CANCELADO },
      recordedSales: GRAVADA,
      estornadas: new Set(),
      reversals: [],
      cutoffFor: () => corte(CORTE),
      ...overrides,
    };
  }

  function soma(...listas: readonly (readonly StockMovementDraft[])[]): number {
    return listas.flat().reduce((total, m) => total + m.qtyDelta, 0);
  }

  it("venda gravada SEM estorno: grava o ESTORNO_FULL que falta e NENHUM CANCELAMENTO_ML", () => {
    const resultado = computeCancellationMovements(entrada());

    expect(resultado.estornosFull).toEqual([
      { skuId: "sku-a", qtyDelta: 1, idempotencyKey: `estorno:${VENDA}`, occurredAt: FECHADO },
    ]);
    expect(resultado.reversals).toEqual([]);
    expect(resultado.estornos).toEqual([]);
    expect(resultado.sales).toEqual([]);
    // -1 (gravada) +1 (estorno) = 0.
    expect(soma([{ ...GRAVADA[0] }] as StockMovementDraft[], resultado.estornosFull)).toBe(0);
  });

  it("venda JA estornada: nada sai — nem estorno de novo, nem reversao", () => {
    const resultado = computeCancellationMovements(entrada({ estornadas: new Set([VENDA]) }));

    expect(resultado).toEqual({
      sales: [],
      estornos: [],
      estornosFull: [],
      excessReversalEstornos: [],
      reversals: [],
      alreadyReversed: [],
    });
  });

  it("contraprova FORA do Full: a mesma entrada reverte, como sempre", () => {
    const resultado = computeCancellationMovements(entrada({ order: { ...entrada().order, logisticType: "cross_docking" } }));

    expect(resultado.estornosFull).toEqual([]);
    expect(resultado.reversals).toEqual([
      { skuId: "sku-a", qtyDelta: 1, idempotencyKey: `cancelamento:${VENDA}`, occurredAt: CANCELADO },
    ]);
  });

  it("o trio da D-351 nao sai para pedido do Full: sem venda gravada, NADA — nao ha reposicao a fazer", () => {
    const resultado = computeCancellationMovements(
      entrada({
        recordedSales: [],
        // Venda anterior ao corte e cancelada depois dele: exatamente o gate do trio.
        order: { ...entrada().order, dateClosed: new Date(CORTE.getTime() - 60_000) },
      }),
    );

    expect(resultado.sales).toEqual([]);
    expect(resultado.estornos).toEqual([]);
    expect(resultado.estornosFull).toEqual([]);
    expect(resultado.reversals).toEqual([]);
  });

  it("KIT do Full: um ESTORNO_FULL por componente gravado, nenhuma reversao", () => {
    const kit: (RecordedSaleMovement & RecordedSale)[] = [
      { skuId: "comp-1", qtyDelta: -4, idempotencyKey: `${VENDA}:comp-1`, occurredAt: FECHADO, recordedAt: FECHADO },
      { skuId: "comp-2", qtyDelta: -2, idempotencyKey: `${VENDA}:comp-2`, occurredAt: FECHADO, recordedAt: FECHADO },
    ];

    const resultado = computeCancellationMovements(entrada({ recordedSales: kit }));

    expect(resultado.estornosFull.map((m) => [m.skuId, m.qtyDelta, m.idempotencyKey])).toEqual([
      ["comp-1", 4, `estorno:${VENDA}:comp-1`],
      ["comp-2", 2, `estorno:${VENDA}:comp-2`],
    ]);
    expect(resultado.reversals).toEqual([]);
    expect(soma(kit as StockMovementDraft[], resultado.estornosFull)).toBe(0);
  });

  it("CANCELAMENTO_ML ja gravado antes de o sinal chegar: o estorno sai E a reversao e anulada — senao sobraria +1", () => {
    const resultado = computeCancellationMovements(
      entrada({
        reversals: [{ idempotencyKey: `cancelamento:${VENDA}`, quantity: 1, occurredAt: CANCELADO }],
      }),
    );

    expect(resultado.estornosFull).toHaveLength(1);
    expect(resultado.excessReversalEstornos).toEqual([
      { skuId: "sku-a", qtyDelta: -1, idempotencyKey: `estorno:cancelamento:${VENDA}`, occurredAt: CANCELADO },
    ]);

    const gravado: StockMovementDraft[] = [
      { skuId: "sku-a", qtyDelta: -1, idempotencyKey: VENDA, occurredAt: FECHADO },
      { skuId: "sku-a", qtyDelta: 1, idempotencyKey: `cancelamento:${VENDA}`, occurredAt: CANCELADO },
    ];

    expect(soma(gravado, resultado.estornosFull, resultado.excessReversalEstornos)).toBe(0);
  });

  it("a anulacao sai de novo mesmo com a venda ja estornada — e o retry que falhou entre o estorno e ela", () => {
    const resultado = computeCancellationMovements(
      entrada({
        estornadas: new Set([VENDA]),
        reversals: [{ idempotencyKey: `cancelamento:${VENDA}`, quantity: 1, occurredAt: CANCELADO }],
      }),
    );

    expect(resultado.estornosFull).toEqual([]);
    expect(resultado.excessReversalEstornos).toHaveLength(1);
  });

  it("reversao suprimida EM QUALQUER ORDEM: cancelamento -> devolucao e devolucao -> cancelamento dao o mesmo zero", () => {
    // (a) o cancelamento chega primeiro e completa o par; a devolucao entregue depois nao acha o que reverter.
    const cancelAntes = computeCancellationMovements(entrada());
    const devolucaoDepois = computeReturnReversal(
      { id: PEDIDO, logisticType: "fulfillment" },
      ITEM,
      GRAVADA,
      [],
      CLAIM,
      DEVOLVIDO,
      new Set(),
      new Set([VENDA]),
    );

    expect(cancelAntes.estornosFull).toHaveLength(1);
    expect(cancelAntes.reversals).toEqual([]);
    expect(devolucaoDepois.movements).toEqual([]);
    expect(devolucaoDepois.estornosFull).toEqual([]);

    // (b) a devolucao chega primeiro; o cancelamento depois nao acrescenta nada.
    const devolucaoAntes = computeReturnReversal(
      { id: PEDIDO, logisticType: "fulfillment" },
      ITEM,
      GRAVADA,
      [],
      CLAIM,
      DEVOLVIDO,
      new Set(),
      new Set(),
    );
    const cancelDepois = computeCancellationMovements(entrada({ estornadas: new Set([VENDA]) }));

    expect(devolucaoAntes.estornosFull).toEqual(cancelAntes.estornosFull);
    expect(devolucaoAntes.movements).toEqual([]);
    expect(cancelDepois.estornosFull).toEqual([]);
    expect(cancelDepois.reversals).toEqual([]);

    const gravada = [{ ...GRAVADA[0] }] as StockMovementDraft[];

    expect(soma(gravada, cancelAntes.estornosFull, devolucaoDepois.movements, devolucaoDepois.estornosFull)).toBe(0);
    expect(soma(gravada, devolucaoAntes.estornosFull, cancelDepois.reversals, cancelDepois.estornosFull)).toBe(0);
  });
});
