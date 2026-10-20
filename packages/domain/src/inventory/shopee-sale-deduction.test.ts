import { describe, expect, it } from "vitest";

import type { ErpCutoff, RecordedSale } from "./sale-deduction.js";
import { computeShopeeStockMovements, shopeeSaleKeyOf } from "./shopee-sale-deduction.js";
import type { ShopeeSaleOrder, ShopeeStockInputs } from "./shopee-sale-deduction.js";

const LOJA = "aaaa4950-0000-4000-8000-00000000a495";
const SKU = "sku-capacete";
const PAGO = new Date("2026-10-20T13:00:00.000Z");
const ANTES = new Date("2026-10-20T12:00:00.000Z");
const DEPOIS = new Date("2026-10-20T14:00:00.000Z");
const CANCELADO_EM = new Date("2026-10-20T16:00:00.000Z");

function pedido(overrides: Partial<ShopeeSaleOrder> = {}): ShopeeSaleOrder {
  return {
    shopId: LOJA,
    orderSn: "251020ABC",
    status: "READY_TO_SHIP",
    paidAt: PAGO,
    updatedAt: PAGO,
    fulfillmentFlag: "fulfilled_by_local_seller",
    items: [{ position: 0, quantity: 2, skuId: SKU, skuKind: "PRODUTO", components: [] }],
    ...overrides,
  };
}

/** A planilha exportada em `exportadaEm` (o mesmo instante de corte, importada uma hora depois). */
function corte(exportadaEm: Date | null, gravadas: Record<string, RecordedSale> = {}): ShopeeStockInputs {
  const c: ErpCutoff | null =
    exportadaEm === null
      ? null
      : {
          capturedAt: exportadaEm,
          exportedAt: exportadaEm,
          importedAt: new Date(exportadaEm.getTime() + 3_600_000),
          reconciledAt: null,
        };

  return { cutoffFor: () => c, recordedSale: (key) => gravadas[key] };
}

const CHAVE = shopeeSaleKeyOf(LOJA, "251020ABC", 0);

describe("computeShopeeStockMovements (D-495)", () => {
  it("venda paga depois da planilha baixa, no instante do pagamento", () => {
    const m = computeShopeeStockMovements(pedido(), corte(ANTES));

    expect(m.vendas).toEqual([{ skuId: SKU, qtyDelta: -2, idempotencyKey: CHAVE, occurredAt: PAGO }]);
    expect(m.estornosPreCaptura).toEqual([]);
    expect(m.estornosArmazem).toEqual([]);
    expect(m.cancelamentos).toEqual([]);
    expect(CHAVE).toBe(`shopee-venda:${LOJA}:251020ABC:0`);
  });

  it("venda até a exportação ganha o estorno do corte: a planilha já a descontou", () => {
    const m = computeShopeeStockMovements(pedido(), corte(DEPOIS));

    expect(m.vendas).toHaveLength(1);
    expect(m.estornosPreCaptura).toEqual([{ skuId: SKU, qtyDelta: 2, idempotencyKey: `estorno:${CHAVE}`, occurredAt: PAGO }]);
  });

  it("sem planilha nenhuma, a venda só baixa", () => {
    const m = computeShopeeStockMovements(pedido(), corte(null));

    expect(m.vendas).toHaveLength(1);
    expect(m.estornosPreCaptura).toEqual([]);
  });

  it("não pago não baixa nada; item sem vínculo também não", () => {
    expect(computeShopeeStockMovements(pedido({ paidAt: null, status: "UNPAID" }), corte(ANTES)).vendas).toEqual([]);
    expect(
      computeShopeeStockMovements(
        pedido({ items: [{ position: 0, quantity: 1, skuId: null, skuKind: null, components: [] }] }),
        corte(ANTES),
      ).vendas,
    ).toEqual([]);
  });

  it("o kit baixa os componentes, uma linha por componente", () => {
    const m = computeShopeeStockMovements(
      pedido({
        items: [
          {
            position: 1,
            quantity: 2,
            skuId: "kit-1",
            skuKind: "KIT",
            components: [
              { componentSkuId: "c-1", quantity: 1 },
              { componentSkuId: "c-2", quantity: 3 },
            ],
          },
        ],
      }),
      corte(ANTES),
    );

    expect(m.vendas.map((v) => [v.skuId, v.qtyDelta, v.idempotencyKey])).toEqual([
      ["c-1", -2, shopeeSaleKeyOf(LOJA, "251020ABC", 1, "c-1")],
      ["c-2", -6, shopeeSaleKeyOf(LOJA, "251020ABC", 1, "c-2")],
    ]);
  });

  it("o armazém da Shopee ganha o par, e o corte tem precedência sobre ele", () => {
    const depois = computeShopeeStockMovements(pedido({ fulfillmentFlag: "fulfilled_by_shopee" }), corte(ANTES));
    const antes = computeShopeeStockMovements(pedido({ fulfillmentFlag: "fulfilled_by_shopee" }), corte(DEPOIS));

    expect(depois.estornosArmazem).toEqual([{ skuId: SKU, qtyDelta: 2, idempotencyKey: `estorno:${CHAVE}`, occurredAt: PAGO }]);
    expect(depois.estornosPreCaptura).toEqual([]);
    // Um estorno só por venda: a chave é a mesma.
    expect(antes.estornosPreCaptura).toHaveLength(1);
    expect(antes.estornosArmazem).toEqual([]);
  });

  it("só a igualdade exata é armazém da Shopee: valor desconhecido ou ausente baixa a loja", () => {
    for (const flag of [null, "fulfilled_by_cb_seller", "FULFILLED_BY_SHOPEE", "outro"]) {
      expect(computeShopeeStockMovements(pedido({ fulfillmentFlag: flag }), corte(ANTES)).estornosArmazem, String(flag)).toEqual([]);
    }
  });

  it("cancelado depois da planilha repõe uma vez, no instante do cancelamento", () => {
    const m = computeShopeeStockMovements(pedido({ status: "CANCELLED", updatedAt: CANCELADO_EM }), corte(ANTES));

    expect(m.vendas).toHaveLength(1);
    expect(m.cancelamentos).toEqual([
      { skuId: SKU, qtyDelta: 2, idempotencyKey: `cancelamento:${CHAVE}`, occurredAt: CANCELADO_EM },
    ]);
  });

  it("vendido antes e cancelado depois da planilha: venda, estorno e cancelamento (o trio)", () => {
    const m = computeShopeeStockMovements(pedido({ status: "CANCELLED", updatedAt: CANCELADO_EM }), corte(DEPOIS));

    expect(m.estornosPreCaptura).toHaveLength(1);
    expect(m.cancelamentos).toHaveLength(1);
  });

  it("cancelado até a exportação não repõe: o UpSeller já repôs na planilha", () => {
    const fim = new Date("2026-10-20T17:00:00.000Z");
    const m = computeShopeeStockMovements(pedido({ status: "CANCELLED", updatedAt: CANCELADO_EM }), corte(fim));

    expect(m.estornosPreCaptura).toHaveLength(1);
    expect(m.cancelamentos).toEqual([]);
  });

  it("o pedido em cancelamento (IN_CANCEL) ainda não repõe: o vendedor pode recusar", () => {
    expect(computeShopeeStockMovements(pedido({ status: "IN_CANCEL", updatedAt: CANCELADO_EM }), corte(ANTES)).cancelamentos).toEqual([]);
  });

  it("o cancelamento do armazém da Shopee não repõe nada: a unidade nunca foi da loja", () => {
    const m = computeShopeeStockMovements(
      pedido({ status: "CANCELLED", updatedAt: CANCELADO_EM, fulfillmentFlag: "fulfilled_by_shopee" }),
      corte(ANTES),
    );

    expect(m.estornosArmazem).toHaveLength(1);
    expect(m.cancelamentos).toEqual([]);
  });

  it("a venda já gravada é a que o estorno e o cancelamento espelham", () => {
    const gravada: RecordedSale = { skuId: SKU, qtyDelta: -2, occurredAt: PAGO, recordedAt: new Date("2026-10-20T13:05:00.000Z") };
    // A planilha nova (exportada depois da venda) chegou DEPOIS de a venda entrar no saldo:
    // o import alinhou o saldo sem ela, então a venda já foi absorvida e não ganha estorno.
    const absorvida = computeShopeeStockMovements(pedido({ status: "CANCELLED", updatedAt: CANCELADO_EM }), corte(DEPOIS, { [CHAVE]: gravada }));

    expect(absorvida.estornosPreCaptura).toEqual([]);
    expect(absorvida.cancelamentos).toEqual([
      { skuId: SKU, qtyDelta: 2, idempotencyKey: `cancelamento:${CHAVE}`, occurredAt: CANCELADO_EM },
    ]);
  });
});
