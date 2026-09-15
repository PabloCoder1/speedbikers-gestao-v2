import { describe, expect, it } from "vitest";

import { computeSaleDeductions, estornadoKeyOf, estornoKeyOf, saleInstant } from "./sale-deduction.js";
import type { PreCaptureCutoffs, RecordedSale, SaleDeductionOrder } from "./sale-deduction.js";

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
    items: [],
    ...overrides,
  };
}

/** Organização sem snapshot: nenhum corte, nenhum VENDA_ML gravado — o comportamento de antes de D-351. */
const SEM_CORTE: PreCaptureCutoffs = { cutoffFor: () => null, recordedSale: () => undefined };

function cortes(
  porSku: Record<string, Date | null>,
  gravadas: Record<string, RecordedSale> = {},
  importedAt: Date = IMPORTADO_EM,
): PreCaptureCutoffs {
  return {
    cutoffFor: (skuId) => {
      if (!(skuId in porSku)) {
        throw new Error(`corte não lido para ${skuId}`);
      }

      const capturedAt = porSku[skuId] ?? null;

      return capturedAt === null ? null : { capturedAt, importedAt };
    },
    recordedSale: (key) => gravadas[key],
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

      expect(computeSaleDeductions(order, SEM_CORTE)).toEqual({ deductions: [], preCaptureReversals: [] });
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
