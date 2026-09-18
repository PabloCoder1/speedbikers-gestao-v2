import { describe, expect, it } from "vitest";

import type { TimedRecordedReversal } from "./reversal-limit.js";
import {
  alignedAt,
  computeSaleDeductions,
  estornadoKeyOf,
  estornaVendaGravada,
  estornoKeyOf,
  FULL_LOGISTIC_TYPE,
  isFullLogistic,
  saleInstant,
} from "./sale-deduction.js";
import type {
  PreCaptureCutoffs,
  RecordedSale,
  SaleDeductionOrder,
  StockMovementDraft,
} from "./sale-deduction.js";

const CREATED_AT = new Date("2026-08-21T12:59:00.000Z");
const CLOSED_AT = new Date("2026-08-21T13:00:00.000Z");
/** Quando a planilha chegou à V3 nos testes: depois de todas as vendas deles. */
const IMPORTADO_EM = new Date("2026-09-14T18:44:19.000Z");

function baseOrder(overrides: Partial<SaleDeductionOrder> = {}): SaleDeductionOrder {
  return {
    id: 9900001001,
    status: "paid",
    dateCreated: CREATED_AT,
    dateClosed: CLOSED_AT,
    // D-352: sem sinal de logística é o padrão dos testes antigos — e o
    // comportamento de antes desta fatia, que eles fixam.
    logisticType: null,
    items: [],
    ...overrides,
  };
}

/** Organização sem snapshot: nenhum corte, nenhum VENDA_ML gravado — o comportamento de antes de D-351. */
const SEM_CORTE: PreCaptureCutoffs = { cutoffFor: () => null, recordedSale: () => undefined, recordedReversals: [] };

function cortes(
  porSku: Record<string, Date | null>,
  gravadas: Record<string, RecordedSale> = {},
  importedAt: Date = IMPORTADO_EM,
  reconciledAt: Date | null = null,
  recordedReversals: TimedRecordedReversal[] = [],
  /** A exportação que a planilha retrata; `null` = o próprio corte (o caso de todo snapshot corrigido). */
  exportedAt: Date | null = null,
): PreCaptureCutoffs {
  return {
    cutoffFor: (skuId) => {
      if (!(skuId in porSku)) {
        throw new Error(`corte não lido para ${skuId}`);
      }

      const capturedAt = porSku[skuId] ?? null;

      return capturedAt === null ? null : { capturedAt, importedAt, reconciledAt, exportedAt: exportedAt ?? capturedAt };
    },
    recordedSale: (key) => gravadas[key],
    recordedReversals,
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

      expect(computeSaleDeductions(order, SEM_CORTE)).toEqual({ deductions: [], preCaptureReversals: [], estornosFull: [], excessReversalEstornos: [] });
    },
  );

  it("PRODUTO: uma linha, quantidade negativa, occurred_at = venda em (date_closed)", () => {
    const order = baseOrder({
      items: [{ position: 0, quantity: 3, skuId: "sku-parafuso", skuKind: "PRODUTO", components: [] }],
    });

    expect(computeSaleDeductions(order, SEM_CORTE).deductions).toEqual([
      {
        skuId: "sku-parafuso",
        qtyDelta: -3,
        idempotencyKey: "venda:9900001001:0",
        occurredAt: CLOSED_AT,
      },
    ]);
  });

  it("sem date_closed, a venda em cai em date_created", () => {
    expect(saleInstant({ dateClosed: null, dateCreated: CREATED_AT })).toEqual(CREATED_AT);
    expect(saleInstant({ dateClosed: CLOSED_AT, dateCreated: CREATED_AT })).toEqual(CLOSED_AT);
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

    expect(computeSaleDeductions(order, SEM_CORTE).deductions).toEqual([
      {
        skuId: "sku-lampada",
        qtyDelta: -4,
        idempotencyKey: "venda:9900001001:1:sku-lampada",
        occurredAt: CLOSED_AT,
      },
      {
        skuId: "sku-suporte",
        qtyDelta: -2,
        idempotencyKey: "venda:9900001001:1:sku-suporte",
        occurredAt: CLOSED_AT,
      },
    ]);
  });

  it("item sem vínculo (skuId nulo) não gera movimento", () => {
    const order = baseOrder({
      items: [{ position: 0, quantity: 1, skuId: null, skuKind: null, components: [] }],
    });

    expect(computeSaleDeductions(order, SEM_CORTE).deductions).toEqual([]);
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

    const result = computeSaleDeductions(order, SEM_CORTE).deductions;

    expect(result).toHaveLength(2);
    expect(result.map((d) => d.skuId)).toEqual(["sku-a", "sku-b"]);
  });

  it("paid e partially_refunded produzem a MESMA chave de idempotência — reprocessar não duplica", () => {
    const items: SaleDeductionOrder["items"] = [
      { position: 0, quantity: 1, skuId: "sku-a", skuKind: "PRODUTO", components: [] },
    ];

    const paid = computeSaleDeductions(baseOrder({ status: "paid", items }), SEM_CORTE).deductions;
    const partiallyRefunded = computeSaleDeductions(
      baseOrder({ status: "partially_refunded", items }),
      SEM_CORTE,
    ).deductions;

    expect(paid[0]?.idempotencyKey).toBe(partiallyRefunded[0]?.idempotencyKey);
  });

  it("pedido sem itens não deduz nada", () => {
    expect(computeSaleDeductions(baseOrder({ items: [] }), SEM_CORTE).deductions).toEqual([]);
  });
});

describe("computeSaleDeductions — estorno da venda anterior ao snapshot (D-351)", () => {
  const PRODUTO: SaleDeductionOrder["items"] = [
    { position: 0, quantity: 2, skuId: "sku-a", skuKind: "PRODUTO", components: [] },
  ];

  it("organização sem snapshot (corte nulo): grava a venda e não estorna — o comportamento de hoje", () => {
    const result = computeSaleDeductions(baseOrder({ items: PRODUTO }), cortes({ "sku-a": null }));

    expect(result.deductions).toHaveLength(1);
    expect(result.preCaptureReversals).toEqual([]);
  });

  it("venda em IGUAL ao corte: grava e estorna, com a MESMA occurred_at e a chave NEUTRA estorno:<chave da venda>", () => {
    const result = computeSaleDeductions(baseOrder({ items: PRODUTO }), cortes({ "sku-a": CLOSED_AT }));

    expect(result.deductions).toEqual([
      { skuId: "sku-a", qtyDelta: -2, idempotencyKey: "venda:9900001001:0", occurredAt: CLOSED_AT },
    ]);
    expect(result.preCaptureReversals).toEqual([
      {
        skuId: "sku-a",
        qtyDelta: 2,
        idempotencyKey: "estorno:venda:9900001001:0",
        occurredAt: CLOSED_AT,
      },
    ]);
  });

  it("venda em 1 ms DEPOIS do corte: venda legítima, sem estorno", () => {
    const corte = new Date(CLOSED_AT.getTime() - 1);
    const result = computeSaleDeductions(baseOrder({ items: PRODUTO }), cortes({ "sku-a": corte }));

    expect(result.deductions).toHaveLength(1);
    expect(result.preCaptureReversals).toEqual([]);
  });

  it("o gate decide por date_closed, não por date_created — criada antes do corte e fechada depois não é estornada", () => {
    const corte = new Date("2026-08-21T12:59:30.000Z");
    const result = computeSaleDeductions(baseOrder({ items: PRODUTO }), cortes({ "sku-a": corte }));

    expect(result.preCaptureReversals).toEqual([]);
  });

  it("KIT com um componente de cada lado do corte: estorna só o componente cujo corte é posterior à venda", () => {
    const order = baseOrder({
      items: [
        {
          position: 0,
          quantity: 1,
          skuId: "sku-kit",
          skuKind: "KIT",
          components: [
            { componentSkuId: "sku-antes", quantity: 2 },
            { componentSkuId: "sku-depois", quantity: 1 },
          ],
        },
      ],
    });

    const result = computeSaleDeductions(
      order,
      cortes({
        // Corte posterior à venda: a planilha já tinha a venda.
        "sku-antes": new Date("2026-08-21T14:00:00.000Z"),
        // Corte anterior à venda: a planilha não tinha.
        "sku-depois": new Date("2026-08-21T12:00:00.000Z"),
      }),
    );

    expect(result.deductions).toHaveLength(2);
    expect(result.preCaptureReversals).toEqual([
      {
        skuId: "sku-antes",
        qtyDelta: 2,
        idempotencyKey: "estorno:venda:9900001001:0:sku-antes",
        occurredAt: CLOSED_AT,
      },
    ]);
  });

  it("VENDA_ML gravado DEPOIS de a planilha chegar (worker antigo): o estorno espelha a linha gravada (SKU, quantidade e data)", () => {
    // Gravado antes de D-351 com occurred_at = date_last_updated, e o vínculo
    // mudou de SKU depois (D-020). O estorno precisa anular AQUELA linha.
    const gravada: RecordedSale = {
      skuId: "sku-antigo",
      qtyDelta: -2,
      occurredAt: new Date("2026-09-14T19:03:00.000Z"),
      recordedAt: new Date("2026-09-14T19:03:05.000Z"),
    };

    const result = computeSaleDeductions(
      baseOrder({ items: PRODUTO }),
      cortes({ "sku-antigo": new Date("2026-09-14T18:42:00.000Z") }, { "venda:9900001001:0": gravada }),
    );

    expect(result.preCaptureReversals).toEqual([
      {
        skuId: "sku-antigo",
        qtyDelta: 2,
        idempotencyKey: "estorno:venda:9900001001:0",
        occurredAt: gravada.occurredAt,
      },
    ]);
  });

  describe("segunda planilha: venda gravada ANTES de o corte chegar não é estornada (ALTA-1)", () => {
    // Venda legítima de 09-15 12:00, gravada na hora; a planilha 2, exportada
    // em 09-16 18:00 (já com a venda descontada), chega às 18:02. O pedido é
    // atualizado (envio) em 09-17.
    const VENDA = new Date("2026-09-15T12:00:00.000Z");
    const CORTE_2 = new Date("2026-09-16T18:00:00.000Z");
    const IMPORT_2 = new Date("2026-09-16T18:02:00.000Z");
    const pedido = baseOrder({ dateClosed: VENDA, items: PRODUTO });

    function gravadaEm(recordedAt: Date): Record<string, RecordedSale> {
      return { "venda:9900001001:0": { skuId: "sku-a", qtyDelta: -2, occurredAt: VENDA, recordedAt } };
    }

    it("gravada antes do import: sem estorno — a reconciliação já a absorveu", () => {
      const result = computeSaleDeductions(
        pedido,
        cortes({ "sku-a": CORTE_2 }, gravadaEm(new Date("2026-09-15T12:00:03.000Z")), IMPORT_2),
      );

      expect(result.preCaptureReversals).toEqual([]);
    });

    it("gravada NO instante do import: sem estorno — só o que entrou depois é estornado", () => {
      expect(computeSaleDeductions(pedido, cortes({ "sku-a": CORTE_2 }, gravadaEm(IMPORT_2), IMPORT_2)).preCaptureReversals).toEqual(
        [],
      );
    });

    it("gravada depois do import (retry do estorno que falhou): estorna", () => {
      const result = computeSaleDeductions(
        pedido,
        cortes({ "sku-a": CORTE_2 }, gravadaEm(new Date(IMPORT_2.getTime() + 1)), IMPORT_2),
      );

      expect(result.preCaptureReversals.map((e) => e.idempotencyKey)).toEqual(["estorno:venda:9900001001:0"]);
    });

    it("rascunho novo (nunca gravado) de venda até o corte: estorna, qualquer que seja o import", () => {
      expect(computeSaleDeductions(pedido, cortes({ "sku-a": CORTE_2 }, {}, IMPORT_2)).preCaptureReversals).toHaveLength(1);
    });
  });

  it("corte não lido LANÇA — nunca vira 'sem corte'", () => {
    expect(() => computeSaleDeductions(baseOrder({ items: PRODUTO }), cortes({}))).toThrow(/corte não lido/);
  });

  it("reprocessar produz os MESMOS pares — o UNIQUE absorve", () => {
    const pre = cortes({ "sku-a": CLOSED_AT });
    const primeira = computeSaleDeductions(baseOrder({ items: PRODUTO }), pre);
    const segunda = computeSaleDeductions(baseOrder({ items: PRODUTO }), pre);

    expect(segunda).toEqual(primeira);
  });
});

/**
 * Verificação de e6fda07, MÉDIA-1: quem absorve a venda gravada não é o import,
 * é o alinhamento do saldo ao alvo — o import, ou uma reconciliação depois dele.
 */
describe("computeSaleDeductions — a venda gravada e o último alinhamento do saldo", () => {
  const PRODUTO: SaleDeductionOrder["items"] = [
    { position: 0, quantity: 1, skuId: "sku-a", skuKind: "PRODUTO", components: [] },
  ];
  // Dev: planilha exportada em 08-20 16:09:23, importada em 08-21 17:12:43; reconciliação em 09-05 09:00:08.
  const CORTE = new Date("2026-08-20T16:09:23.000Z");
  const IMPORT = new Date("2026-08-21T17:12:43.810Z");
  const RECONCILIACAO = new Date("2026-09-05T09:00:08.000Z");
  const pedido = baseOrder({ dateClosed: new Date("2026-08-15T10:00:00.000Z"), items: PRODUTO });

  function gravada(occurredAt: Date, recordedAt: Date): Record<string, RecordedSale> {
    return { "venda:9900001001:0": { skuId: "sku-a", qtyDelta: -1, occurredAt, recordedAt } };
  }

  it("(b) linha até o corte, gravada depois do import e ANTES da reconciliação: sem estorno — a reconciliação a absorveu", () => {
    const result = computeSaleDeductions(
      pedido,
      cortes({ "sku-a": CORTE }, gravada(new Date("2026-08-15T10:00:00.000Z"), new Date("2026-08-22T03:00:00.000Z")), IMPORT, RECONCILIACAO),
    );

    expect(result.preCaptureReversals).toEqual([]);
  });

  it("(b) a mesma linha gravada DEPOIS da reconciliação: estorna", () => {
    const result = computeSaleDeductions(
      pedido,
      cortes({ "sku-a": CORTE }, gravada(new Date("2026-08-15T10:00:00.000Z"), new Date(RECONCILIACAO.getTime() + 1)), IMPORT, RECONCILIACAO),
    );

    expect(result.preCaptureReversals.map((e) => e.idempotencyKey)).toEqual(["estorno:venda:9900001001:0"]);
  });

  it("(b) gravada NO instante da reconciliação: sem estorno — a fronteira é a mesma do import", () => {
    expect(
      computeSaleDeductions(pedido, cortes({ "sku-a": CORTE }, gravada(new Date("2026-08-15T10:00:00.000Z"), RECONCILIACAO), IMPORT, RECONCILIACAO))
        .preCaptureReversals,
    ).toEqual([]);
  });

  it("(b) reconciliação ANTERIOR ao import não conta: vale o import", () => {
    const antes = new Date(IMPORT.getTime() - 60_000);

    expect(alignedAt({ capturedAt: CORTE, importedAt: IMPORT, reconciledAt: antes, exportedAt: CORTE })).toEqual(IMPORT);
    expect(
      computeSaleDeductions(pedido, cortes({ "sku-a": CORTE }, gravada(new Date("2026-08-15T10:00:00.000Z"), new Date(IMPORT.getTime() + 1)), IMPORT, antes))
        .preCaptureReversals,
    ).toHaveLength(1);
  });

  it("(a) linha do worker antigo com occurred_at DEPOIS do corte: estorna sempre, espelhada — mesmo gravada antes do import e da reconciliação", () => {
    const occurredAt = new Date("2026-08-20T18:00:00.000Z");
    const result = computeSaleDeductions(
      pedido,
      cortes({ "sku-a": CORTE }, gravada(occurredAt, new Date("2026-08-20T18:00:05.000Z")), IMPORT, RECONCILIACAO),
    );

    expect(result.preCaptureReversals).toEqual([
      { skuId: "sku-a", qtyDelta: 1, idempotencyKey: "estorno:venda:9900001001:0", occurredAt },
    ]);
  });
});

/**
 * Verificação de e6fda07, ALTA-1: o legado gravou cancelamento E devolução da
 * mesma venda. O excesso já anulou a venda; o estorno é só o que sobra.
 */
describe("computeSaleDeductions — estorno de venda com reversão em excesso do legado (D-351 §12)", () => {
  const PRODUTO: SaleDeductionOrder["items"] = [
    { position: 0, quantity: 1, skuId: "sku-a", skuKind: "PRODUTO", components: [] },
  ];
  const CORTE = new Date("2026-09-14T18:42:00.000Z");
  const pedido = baseOrder({ dateClosed: new Date("2026-08-31T21:05:29.000Z"), items: PRODUTO });
  const VENDIDA_EM = new Date("2026-09-15T01:50:58.000Z");
  // 2000018212899604 de produção: gravada pelo worker antigo às 02:00 de 09-15 com a data da atualização.
  const GRAVADA: Record<string, RecordedSale> = {
    "venda:9900001001:0": {
      skuId: "sku-a",
      qtyDelta: -1,
      occurredAt: VENDIDA_EM,
      recordedAt: new Date("2026-09-15T02:00:05.948Z"),
    },
  };
  const DEVOLVIDA_EM = new Date("2026-09-15T08:39:04.000Z");
  const CANCELADA_EM = new Date("2026-09-15T08:40:07.000Z");
  const DEVOLUCAO: TimedRecordedReversal = {
    idempotencyKey: "devolucao:5570995770:venda:9900001001:0",
    quantity: 1,
    occurredAt: DEVOLVIDA_EM,
  };
  const CANCELAMENTO: TimedRecordedReversal = { idempotencyKey: "cancelamento:venda:9900001001:0", quantity: 1, occurredAt: CANCELADA_EM };

  it("devolução E cancelamento gravados: o estorno da venda inteira, e a anulação da reversão mais recente (o cancelamento) com o instante dela -- o líquido fica +1", () => {
    const result = computeSaleDeductions(pedido, cortes({ "sku-a": CORTE }, GRAVADA, IMPORTADO_EM, null, [DEVOLUCAO, CANCELAMENTO]));

    expect(result.preCaptureReversals).toEqual([
      { skuId: "sku-a", qtyDelta: 1, idempotencyKey: "estorno:venda:9900001001:0", occurredAt: VENDIDA_EM },
    ]);
    expect(result.excessReversalEstornos).toEqual([
      { skuId: "sku-a", qtyDelta: -1, idempotencyKey: "estorno:cancelamento:venda:9900001001:0", occurredAt: CANCELADA_EM },
    ]);
    // -1 (venda) +1 (devolução) +1 (cancelamento) +1 (estorno) -1 (anulação).
    expect(-1 + 1 + 1 + [...result.preCaptureReversals, ...result.excessReversalEstornos].reduce((soma, m) => soma + m.qtyDelta, 0)).toBe(1);
  });

  it("só a devolução gravada (R = V): o estorno inteiro, sem anulação", () => {
    const result = computeSaleDeductions(pedido, cortes({ "sku-a": CORTE }, GRAVADA, IMPORTADO_EM, null, [DEVOLUCAO]));

    expect(result.preCaptureReversals.map((e) => e.qtyDelta)).toEqual([1]);
    expect(result.excessReversalEstornos).toEqual([]);
  });

  it("R < V (3 vendidas, 1 devolvida): o estorno inteiro, sem anulação -- nada muda", () => {
    const tres: Record<string, RecordedSale> = { "venda:9900001001:0": { ...GRAVADA["venda:9900001001:0"], qtyDelta: -3 } as RecordedSale };
    const result = computeSaleDeductions(pedido, cortes({ "sku-a": CORTE }, tres, IMPORTADO_EM, null, [DEVOLUCAO]));

    expect(result.preCaptureReversals.map((e) => e.qtyDelta)).toEqual([3]);
    expect(result.excessReversalEstornos).toEqual([]);
  });

  it("excesso parcial (3 vendidas, cancelamento de 3 e devolução de 1): o estorno é a venda INTEIRA, e a anulação é o que passou, na reversão mais recente", () => {
    const tres: Record<string, RecordedSale> = { "venda:9900001001:0": { ...GRAVADA["venda:9900001001:0"], qtyDelta: -3 } as RecordedSale };
    const result = computeSaleDeductions(
      pedido,
      cortes({ "sku-a": CORTE }, tres, IMPORTADO_EM, null, [
        { idempotencyKey: "cancelamento:venda:9900001001:0", quantity: 3, occurredAt: DEVOLVIDA_EM },
        { idempotencyKey: "devolucao:1:venda:9900001001:0", quantity: 1, occurredAt: CANCELADA_EM },
      ]),
    );

    expect(result.preCaptureReversals.map((e) => e.qtyDelta)).toEqual([3]);
    expect(result.excessReversalEstornos.map((e) => [e.idempotencyKey, e.qtyDelta, e.occurredAt])).toEqual([
      ["estorno:devolucao:1:venda:9900001001:0", -1, CANCELADA_EM],
    ]);
  });

  it("KIT de 3 componentes com a VENDA do worker antigo ATÉ o corte (2000017792822486): uma anulação por componente, com o instante do cancelamento", () => {
    const componentes = ["comp-a", "comp-b", "comp-c"];
    const chave = (componente: string) => `venda:9900001001:0:${componente}`;
    const vendidaAntes = new Date("2026-09-14T18:11:20.000Z");
    const canceladaEm = new Date("2026-09-16T12:58:04.000Z");
    const kit = baseOrder({
      dateClosed: new Date("2026-08-06T18:25:09.000Z"),
      items: [
        {
          position: 0,
          quantity: 1,
          skuId: "kit",
          skuKind: "KIT",
          components: componentes.map((componentSkuId) => ({ componentSkuId, quantity: 1 })),
        },
      ],
    });
    const gravadas = Object.fromEntries(
      componentes.map((componente) => [
        chave(componente),
        { skuId: componente, qtyDelta: -1, occurredAt: vendidaAntes, recordedAt: new Date("2026-09-14T19:00:06.564Z") },
      ]),
    );
    const reversoes = componentes.flatMap((componente) => [
      { idempotencyKey: `devolucao:5571421181:${chave(componente)}`, quantity: 1, occurredAt: new Date("2026-09-16T00:12:31.170Z") },
      { idempotencyKey: `cancelamento:${chave(componente)}`, quantity: 1, occurredAt: canceladaEm },
    ]);

    const result = computeSaleDeductions(
      kit,
      cortes(Object.fromEntries(componentes.map((c) => [c, CORTE])), gravadas, new Date("2026-09-14T18:44:19.581Z"), null, reversoes),
    );

    expect(result.preCaptureReversals.map((e) => [e.idempotencyKey, e.qtyDelta, e.occurredAt])).toEqual(
      componentes.map((componente) => [`estorno:${chave(componente)}`, 1, vendidaAntes]),
    );
    expect(result.excessReversalEstornos.map((e) => [e.skuId, e.idempotencyKey, e.qtyDelta, e.occurredAt])).toEqual(
      componentes.map((componente) => [componente, `estorno:cancelamento:${chave(componente)}`, -1, canceladaEm]),
    );
  });

  it("venda absorvida (gravada antes do import): sem estorno, e sem anulação", () => {
    const absorvida: Record<string, RecordedSale> = {
      "venda:9900001001:0": {
        skuId: "sku-a",
        qtyDelta: -1,
        occurredAt: new Date("2026-09-14T18:00:00.000Z"),
        recordedAt: new Date("2026-09-14T18:00:03.000Z"),
      },
    };
    const result = computeSaleDeductions(pedido, cortes({ "sku-a": CORTE }, absorvida, IMPORTADO_EM, null, [DEVOLUCAO, CANCELAMENTO]));

    expect(result.preCaptureReversals).toEqual([]);
    expect(result.excessReversalEstornos).toEqual([]);
  });
});

describe("chave neutra do estorno (D-351)", () => {
  it("estorno:<chave do movimento>, sem a causa — o tipo diz a causa", () => {
    expect(estornoKeyOf("venda:1:0")).toBe("estorno:venda:1:0");
    expect(estornadoKeyOf("estorno:venda:1:0:sku-b")).toBe("venda:1:0:sku-b");
  });

  it.each(["estorno-pre-captura:venda:1:0", "venda:1:0", "estorno:"])(
    "chave de estorno fora do formato LANÇA (%s)",
    (chave) => {
      expect(() => estornadoKeyOf(chave)).toThrow(/fora do formato/);
    },
  );
});

/**
 * Reverificação de c48fb70, MÉDIA-1: no snapshot que ainda carrega o parse de uma
 * planilha com o nome carimbado (a organização reconciliada do Dev), a planilha
 * retrata a EXPORTAÇÃO (`exportedAt`) e o alvo começa no parse (`capturedAt`).
 * Os instantes são os do Dev.
 */
describe("computeSaleDeductions — a planilha retrata a exportação, e não o corte do parse (reverificação de c48fb70, MÉDIA-1)", () => {
  const PRODUTO: SaleDeductionOrder["items"] = [
    { position: 0, quantity: 1, skuId: "sku-a", skuKind: "PRODUTO", components: [] },
  ];
  // Lista_de_Estoque_0820160923.xlsx: exportada em 08-20 16:09:23, parse (o corte que a
  // migration deixa na organização reconciliada) em 08-21 15:42:02.459, import em
  // 08-21 17:12:43.810, última rodada da reconciliação em 09-14 09:00:02.157.
  const EXPORTACAO = new Date("2026-08-20T16:09:23.000Z");
  const PARSE = new Date("2026-08-21T15:42:02.459Z");
  const IMPORT = new Date("2026-08-21T17:12:43.810Z");
  const RODADA = new Date("2026-09-14T09:00:02.157Z");
  // 2000018048056108: fechado em 08-21 12:37:59 -- depois da exportação, antes do parse.
  const NA_JANELA = baseOrder({ dateClosed: new Date("2026-08-21T12:37:59.000Z"), items: PRODUTO });
  const ANTES_DA_EXPORTACAO = baseOrder({ dateClosed: new Date("2026-08-20T10:00:00.000Z"), items: PRODUTO });

  function doDev(gravadas: Record<string, RecordedSale> = {}): PreCaptureCutoffs {
    return cortes({ "sku-a": PARSE }, gravadas, IMPORT, RODADA, [], EXPORTACAO);
  }

  function gravada(occurredAt: Date, recordedAt: Date): Record<string, RecordedSale> {
    return { "venda:9900001001:0": { skuId: "sku-a", qtyDelta: -1, occurredAt, recordedAt } };
  }

  it("(a) linha do worker antigo DEPOIS do corte, de venda entre a exportação e o parse: sem estorno — a planilha não tem a venda, e o -1 que o alvo conta é o certo (708 linhas no Dev)", () => {
    const result = computeSaleDeductions(
      NA_JANELA,
      doDev(gravada(new Date("2026-09-06T12:33:31.000Z"), new Date("2026-09-06T12:33:33.116Z"))),
    );

    expect(result.preCaptureReversals).toEqual([]);
  });

  it("rascunho novo de venda entre a exportação e o parse (os 4 pedidos pagos do Dev sem VENDA_ML): grava a venda e não estorna", () => {
    const result = computeSaleDeductions(NA_JANELA, doDev());

    expect(result.deductions).toHaveLength(1);
    expect(result.preCaptureReversals).toEqual([]);
  });

  it("venda EXATAMENTE na exportação: estorna — a planilha tem a venda (a fronteira `<=` do gate)", () => {
    const result = computeSaleDeductions(baseOrder({ dateClosed: EXPORTACAO, items: PRODUTO }), doDev());

    expect(result.preCaptureReversals).toEqual([
      { skuId: "sku-a", qtyDelta: 1, idempotencyKey: "estorno:venda:9900001001:0", occurredAt: EXPORTACAO },
    ]);
  });

  it("(a) venda ANTES da exportação, linha do worker antigo depois do corte: estorna, espelhada — a planilha tem a venda e o alvo a conta de novo (1.566 linhas no Dev)", () => {
    const occurredAt = new Date("2026-09-06T12:40:00.000Z");
    const result = computeSaleDeductions(ANTES_DA_EXPORTACAO, doDev(gravada(occurredAt, new Date("2026-09-06T12:40:02.000Z"))));

    expect(result.preCaptureReversals).toEqual([
      { skuId: "sku-a", qtyDelta: 1, idempotencyKey: "estorno:venda:9900001001:0", occurredAt },
    ]);
  });

  it("(b) venda antes da exportação, linha ENTRE a exportação e o parse, gravada antes do import: sem estorno — o lado do alvo é o do corte (captured_at), e não o da exportação", () => {
    const result = computeSaleDeductions(
      ANTES_DA_EXPORTACAO,
      doDev(gravada(new Date("2026-08-21T10:00:00.000Z"), new Date("2026-08-21T10:00:05.000Z"))),
    );

    expect(result.preCaptureReversals).toEqual([]);
  });
});

/**
 * Reverificação de c48fb70, MUT-X2: a fronteira do ramo (a) é estrita, como a do alvo
 * (`occurred_at > captured_at`). A linha gravada NO corte está fora do alvo.
 */
describe("estornaVendaGravada — a linha gravada NO corte (reverificação de c48fb70, MUT-X2)", () => {
  // Produção: o corte vem do nome do arquivo, em segundo cheio, e todo date_closed também. A
  // venda fechou no segundo da exportação e o worker novo a gravou antes do import.
  const CORTE = new Date("2026-09-14T18:42:00.000Z");
  const IMPORT = new Date("2026-09-14T18:44:19.581Z");
  const NO_CORTE: RecordedSale = {
    skuId: "sku-a",
    qtyDelta: -1,
    occurredAt: CORTE,
    recordedAt: new Date("2026-09-14T18:42:03.000Z"),
  };

  it("occurred_at IGUAL ao corte, gravada antes do import e sem reconciliação: não estorna — a planilha tem a venda e o alvo não conta a linha", () => {
    expect(estornaVendaGravada(NO_CORTE, { capturedAt: CORTE, importedAt: IMPORT, reconciledAt: null, exportedAt: CORTE })).toBe(false);

    const result = computeSaleDeductions(
      baseOrder({ dateClosed: CORTE, items: [{ position: 0, quantity: 1, skuId: "sku-a", skuKind: "PRODUTO", components: [] }] }),
      cortes({ "sku-a": CORTE }, { "venda:9900001001:0": NO_CORTE }, IMPORT),
    );

    expect(result.preCaptureReversals).toEqual([]);
  });
});

/**
 * D-352 — a venda entregue pelo Full nao baixa o estoque da LOJA.
 *
 * O invariante desta fatia, e o que todo teste daqui mede: o par (venda,
 * `ESTORNO_FULL`) soma ZERO no saldo E no alvo de `compute_erp_target_balances`,
 * que so soma `occurred_at > captured_at`. Espelhar a data e o que mantem as
 * duas linhas do MESMO lado do corte — e e por isso que o alvo tambem e
 * conferido, e nao so o saldo.
 */
describe("computeSaleDeductions — venda entregue pelo Full (D-352)", () => {
  const PRODUTO: SaleDeductionOrder["items"] = [
    { position: 0, quantity: 2, skuId: "sku-a", skuKind: "PRODUTO", components: [] },
  ];
  const VENDA = "venda:9900001001:0";

  /** O saldo: a soma de tudo, que o trigger `apply_to_balance` aplica linha a linha. */
  function noSaldo(...listas: readonly StockMovementDraft[][]): number {
    return listas.flat().reduce((total, m) => total + m.qtyDelta, 0);
  }

  /** O alvo: `compute_erp_target_balances` soma SO o movimento depois do corte. */
  function noAlvo(corteDoAlvo: Date, ...listas: readonly StockMovementDraft[][]): number {
    return listas
      .flat()
      .filter((m) => m.occurredAt.getTime() > corteDoAlvo.getTime())
      .reduce((total, m) => total + m.qtyDelta, 0);
  }

  function doFull(overrides: Partial<SaleDeductionOrder> = {}): SaleDeductionOrder {
    return baseOrder({ logisticType: FULL_LOGISTIC_TYPE, items: PRODUTO, ...overrides });
  }

  it("so 'fulfillment' e Full — nem maiuscula, nem outro tipo de logistica, nem a ausencia do sinal", () => {
    expect(isFullLogistic("fulfillment")).toBe(true);
    expect(isFullLogistic("FULFILLMENT")).toBe(false);
    expect(isFullLogistic("cross_docking")).toBe(false);
    expect(isFullLogistic("drop_off")).toBe(false);
    expect(isFullLogistic("")).toBe(false);
    expect(isFullLogistic(null)).toBe(false);
  });

  it("PRODUTO: grava a venda e o par ESTORNO_FULL, com a MESMA occurred_at e a chave NEUTRA", () => {
    const result = computeSaleDeductions(doFull(), cortes({ "sku-a": null }));

    expect(result.deductions).toEqual([
      { skuId: "sku-a", qtyDelta: -2, idempotencyKey: VENDA, occurredAt: CLOSED_AT },
    ]);
    expect(result.estornosFull).toEqual([
      { skuId: "sku-a", qtyDelta: 2, idempotencyKey: `estorno:${VENDA}`, occurredAt: CLOSED_AT },
    ]);
    expect(result.preCaptureReversals).toEqual([]);
  });

  it("o par soma ZERO no saldo E no alvo — de qualquer lado do corte", () => {
    const { deductions, estornosFull } = computeSaleDeductions(doFull(), cortes({ "sku-a": null }));

    expect(noSaldo(deductions, estornosFull)).toBe(0);
    // Corte ANTES da venda: as duas linhas caem DENTRO do alvo.
    expect(noAlvo(new Date(CLOSED_AT.getTime() - 60_000), deductions, estornosFull)).toBe(0);
    // Corte DEPOIS da venda: as duas caem FORA.
    expect(noAlvo(new Date(CLOSED_AT.getTime() + 60_000), deductions, estornosFull)).toBe(0);
    // Corte NO instante da venda: a fronteira e estrita, as duas ficam fora juntas.
    expect(noAlvo(CLOSED_AT, deductions, estornosFull)).toBe(0);
    // E a prova de que o alvo mudaria se o espelho NAO fosse espelho: so a venda, dentro.
    expect(noAlvo(new Date(CLOSED_AT.getTime() - 60_000), deductions)).toBe(-2);
  });

  it("KIT do Full: um par por COMPONENTE, com a chave do componente — o kit nao tem saldo proprio", () => {
    const order = doFull({
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

    const result = computeSaleDeductions(order, cortes({ "sku-lampada": null, "sku-suporte": null }));

    expect(result.estornosFull).toEqual([
      {
        skuId: "sku-lampada",
        qtyDelta: 4,
        idempotencyKey: "estorno:venda:9900001001:1:sku-lampada",
        occurredAt: CLOSED_AT,
      },
      {
        skuId: "sku-suporte",
        qtyDelta: 2,
        idempotencyKey: "estorno:venda:9900001001:1:sku-suporte",
        occurredAt: CLOSED_AT,
      },
    ]);
    expect(noSaldo(result.deductions, result.estornosFull)).toBe(0);
  });

  it("sinal AUSENTE baixa a loja como sempre — nunca presumir Full", () => {
    const result = computeSaleDeductions(baseOrder({ logisticType: null, items: PRODUTO }), cortes({ "sku-a": null }));

    expect(result.deductions).toHaveLength(1);
    expect(result.estornosFull).toEqual([]);
    expect(noSaldo(result.deductions, result.estornosFull)).toBe(-2);
  });

  it.each(["cross_docking", "drop_off", "xd_drop_off", "self_service", "logistica_que_o_ML_inventar"])(
    "valor DESCONHECIDO de logistic_type (%s) baixa a loja — errar para 'baixa' e o lado seguro",
    (logisticType) => {
      const result = computeSaleDeductions(baseOrder({ logisticType, items: PRODUTO }), cortes({ "sku-a": null }));

      expect(result.deductions).toHaveLength(1);
      expect(result.estornosFull).toEqual([]);
    },
  );

  it("venda anterior a planilha E do Full: UM estorno so, o da pre-captura — as duas causas dividem a chave", () => {
    const result = computeSaleDeductions(doFull(), cortes({ "sku-a": CLOSED_AT }));

    expect(result.preCaptureReversals).toEqual([
      { skuId: "sku-a", qtyDelta: 2, idempotencyKey: `estorno:${VENDA}`, occurredAt: CLOSED_AT },
    ]);
    expect(result.estornosFull).toEqual([]);
    // A prova de que a duplicata e impossivel: nenhuma chave nas duas listas.
    const chaves = [...result.preCaptureReversals, ...result.estornosFull].map((m) => m.idempotencyKey);

    expect(new Set(chaves).size).toBe(chaves.length);
    expect(noSaldo(result.deductions, result.preCaptureReversals, result.estornosFull)).toBe(0);
  });

  it("venda JA GRAVADA com a data velha: o ESTORNO_FULL espelha a LINHA, nao a venda em — o par fica do mesmo lado do corte", () => {
    // O worker de antes de D-351 gravava `occurred_at = date_last_updated`.
    const GRAVADA_EM = new Date("2026-09-14T19:00:00.000Z");
    const gravada: RecordedSale = { skuId: "sku-a", qtyDelta: -2, occurredAt: GRAVADA_EM, recordedAt: GRAVADA_EM };

    const result = computeSaleDeductions(doFull(), cortes({ "sku-a": null }, { [VENDA]: gravada }));

    expect(result.estornosFull).toEqual([
      { skuId: "sku-a", qtyDelta: 2, idempotencyKey: `estorno:${VENDA}`, occurredAt: GRAVADA_EM },
    ]);
    // A linha que de fato move o saldo e a gravada: o rascunho novo e descartado pelo UNIQUE.
    const gravadoENovo = [{ ...gravada, idempotencyKey: VENDA }, ...result.estornosFull];

    expect(noSaldo(gravadoENovo)).toBe(0);
    expect(noAlvo(new Date(GRAVADA_EM.getTime() - 1), gravadoENovo)).toBe(0);
  });

  it("reversao ja gravada de venda do Full: anulada INTEIRA, nao so o excesso — nada devia ter voltado para a loja", () => {
    const CANCELADO_EM = new Date("2026-09-15T10:00:00.000Z");
    const result = computeSaleDeductions(
      doFull(),
      cortes({ "sku-a": null }, {}, IMPORTADO_EM, null, [
        { idempotencyKey: `cancelamento:${VENDA}`, quantity: 2, occurredAt: CANCELADO_EM },
      ]),
    );

    expect(result.excessReversalEstornos).toEqual([
      { skuId: "sku-a", qtyDelta: -2, idempotencyKey: `estorno:cancelamento:${VENDA}`, occurredAt: CANCELADO_EM },
    ]);
    // -2 (venda) +2 (ESTORNO_FULL) +2 (cancelamento GRAVADO) -2 (anulacao) = 0.
    const gravado = [{ skuId: "sku-a", qtyDelta: 2, idempotencyKey: `cancelamento:${VENDA}`, occurredAt: CANCELADO_EM }];

    expect(noSaldo(result.deductions, result.estornosFull, gravado, result.excessReversalEstornos)).toBe(0);
    expect(noAlvo(new Date(CLOSED_AT.getTime() - 1), result.deductions, result.estornosFull, gravado, result.excessReversalEstornos)).toBe(0);
  });

  it("contraprova FORA do Full: a mesma reversao gravada nao vira anulacao nenhuma — ela devolveu de verdade", () => {
    const CANCELADO_EM = new Date("2026-09-15T10:00:00.000Z");
    const result = computeSaleDeductions(
      baseOrder({ logisticType: "cross_docking", items: PRODUTO }),
      cortes({ "sku-a": CLOSED_AT }, {}, IMPORTADO_EM, null, [
        { idempotencyKey: `cancelamento:${VENDA}`, quantity: 2, occurredAt: CANCELADO_EM },
      ]),
    );

    // R = V: nada passou da venda, entao a D-351 nao anula nada.
    expect(result.excessReversalEstornos).toEqual([]);
    expect(result.preCaptureReversals).toHaveLength(1);
  });
});
