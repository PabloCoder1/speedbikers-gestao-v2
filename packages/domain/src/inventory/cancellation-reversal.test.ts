import { describe, expect, it } from "vitest";

import { computeCancellationMovements, computeCancellationReversals } from "./cancellation-reversal.js";
import type {
  CancellationMovementsInput,
  CancellationPreCapture,
  CancellationReversalOrder,
  RecordedSaleMovement,
} from "./cancellation-reversal.js";
import { computeReturnReversal } from "./return-reversal.js";
import type { RecordedReversal } from "./reversal-limit.js";
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

  function comoReversao(drafts: readonly StockMovementDraft[]): RecordedReversal[] {
    return drafts.map((d) => ({ idempotencyKey: d.idempotencyKey, quantity: d.qtyDelta }));
  }

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
        entrada({ order: DEPOIS_DO_CORTE, recordedSales: LEGITIMA, reversals: [{ idempotencyKey: `devolucao:${CLAIM}:${VENDA}`, quantity: 1 }] }),
      );

      expect(resultado.reversals).toEqual([]);
      expect(resultado.alreadyReversed).toEqual([VENDA]);
    });

    it("devolução parcial antes: o cancelamento reverte só o restante", () => {
      const tres = [{ ...LEGITIMA[0], qtyDelta: -3 } as RecordedSaleMovement & RecordedSale];
      const resultado = computeCancellationMovements(
        entrada({ order: DEPOIS_DO_CORTE, recordedSales: tres, reversals: [{ idempotencyKey: `devolucao:${CLAIM}:${VENDA}`, quantity: 1 }] }),
      );

      expect(resultado.reversals.map((r) => [r.idempotencyKey, r.qtyDelta])).toEqual([[`cancelamento:${VENDA}`, 2]]);
    });

    it("reprocessar o cancelamento já gravado: a própria linha fica fora da soma e o movimento sai igual (o UNIQUE absorve)", () => {
      const resultado = computeCancellationMovements(
        entrada({ order: DEPOIS_DO_CORTE, recordedSales: LEGITIMA, reversals: [{ idempotencyKey: `cancelamento:${VENDA}`, quantity: 1 }] }),
      );

      expect(resultado.reversals.map((r) => [r.idempotencyKey, r.qtyDelta])).toEqual([[`cancelamento:${VENDA}`, 1]]);
      expect(resultado.alreadyReversed).toEqual([]);
    });

    it("2000018212899604 de produção (VENDA do worker antigo + DEVOLUCAO + CANCELAMENTO): nenhum estorno e nenhum cancelamento novo — o líquido fica +1", () => {
      const gravada: (RecordedSaleMovement & RecordedSale)[] = [
        {
          skuId: "sku-a",
          qtyDelta: -1,
          idempotencyKey: VENDA,
          occurredAt: new Date("2026-09-15T01:50:58.000Z"),
          recordedAt: new Date("2026-09-15T02:00:05.948Z"),
        },
      ];
      const reversals: RecordedReversal[] = [
        { idempotencyKey: `devolucao:${CLAIM}:${VENDA}`, quantity: 1 },
        { idempotencyKey: `cancelamento:${VENDA}`, quantity: 1 },
      ];

      const resultado = computeCancellationMovements(entrada({ recordedSales: gravada, reversals }));

      expect(resultado.estornos).toEqual([]);
      // O cancelamento já gravado sai de novo (o UNIQUE absorve)? Não: a devolução já devolveu a unidade.
      expect(resultado.reversals).toEqual([]);
      expect(resultado.alreadyReversed).toEqual([VENDA]);
      // Ledger do pedido: -1 (venda) +1 (devolução) +1 (cancelamento) = +1, igual ao real.
      expect(-1 + 1 + 1 + liquido(resultado.sales, resultado.estornos, resultado.reversals)).toBe(1);
    });

    it("trio seguido da devolução entregue: a devolução não devolve a unidade de novo — líquido +1", () => {
      const trio = computeCancellationMovements(
        entrada({ transition: { saleStatus: "paid", cancelledAt: new Date("2026-09-15T01:36:10.000Z") } }),
      );

      expect(trio.sales).toHaveLength(1);

      const devolucao = computeReturnReversal(
        { id: PEDIDO },
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
        { id: PEDIDO },
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

    expect(resultado).toEqual({ sales: [], estornos: [], reversals: [], alreadyReversed: [] });
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
