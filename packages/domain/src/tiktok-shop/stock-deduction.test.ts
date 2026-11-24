import { describe, expect, it } from "vitest";

import type { ErpCutoff } from "../inventory/sale-deduction.js";
import {
  computeTikTokStockMovements,
  tiktokSaleKeyOf,
  type TikTokSaleOrder,
  type TikTokStockInputs,
} from "./stock-deduction.js";

const CORTE_DATA = new Date("2026-11-20T12:00:00.000Z");
const CORTE: ErpCutoff = {
  exportedAt: CORTE_DATA,
  capturedAt: CORTE_DATA,
  importedAt: CORTE_DATA,
  reconciledAt: CORTE_DATA,
};
const ANTES = new Date("2026-11-20T10:00:00.000Z");
const DEPOIS = new Date("2026-11-20T15:00:00.000Z");
const CANCELADO_DEPOIS = new Date("2026-11-20T18:00:00.000Z");

function inputs(corte: ErpCutoff | null = CORTE): TikTokStockInputs {
  return {
    cutoffFor: () => corte,
    recordedSale: () => undefined,
  };
}

function pedido(parcial: Partial<TikTokSaleOrder> = {}): TikTokSaleOrder {
  return {
    shopId: "shop-tt-1",
    orderId: "576461413038785752",
    status: "AWAITING_SHIPMENT",
    paidAt: DEPOIS,
    updatedAt: DEPOIS,
    fulfillmentType: "FULFILLMENT_BY_SELLER",
    orderDeductionEnabled: true,
    items: [
      {
        position: 0,
        quantity: 2,
        skuId: "sku-1",
        skuKind: "PRODUTO",
        components: [],
      },
    ],
    ...parcial,
  };
}

describe("baixa e reversão de estoque do TikTok Shop (D-809, guarda D-497)", () => {
  it("guarda D-497: sem autorização explícita de baixa pelo pedido, não gera movimentos (evita dupla baixa com NF-e)", () => {
    const movs = computeTikTokStockMovements(pedido({ orderDeductionEnabled: false }), inputs());

    expect(movs).toEqual({ vendas: [], estornosPreCaptura: [], estornosFbt: [], cancelamentos: [] });
  });

  it("venda paga em ON_HOLD ou UNPAID não baixa estoque antes de passar da janela de arrependimento", () => {
    expect(computeTikTokStockMovements(pedido({ status: "UNPAID", paidAt: null }), inputs()).vendas).toEqual([]);
    expect(computeTikTokStockMovements(pedido({ status: "ON_HOLD" }), inputs()).vendas).toEqual([]);
  });

  it("venda paga pós-corte baixa LOCAL (incluindo expansão de KIT); pré-corte gera par com estorno pré-captura", () => {
    const pos = computeTikTokStockMovements(
      pedido({
        items: [
          {
            position: 0,
            quantity: 2,
            skuId: "kit-1",
            skuKind: "KIT",
            components: [
              { componentSkuId: "comp-a", quantity: 1 },
              { componentSkuId: "comp-b", quantity: 3 },
            ],
          },
        ],
      }),
      inputs(),
    );

    expect(pos.vendas).toEqual([
      {
        skuId: "comp-a",
        qtyDelta: -2,
        idempotencyKey: tiktokSaleKeyOf("shop-tt-1", "576461413038785752", 0, "comp-a"),
        occurredAt: DEPOIS,
      },
      {
        skuId: "comp-b",
        qtyDelta: -6,
        idempotencyKey: tiktokSaleKeyOf("shop-tt-1", "576461413038785752", 0, "comp-b"),
        occurredAt: DEPOIS,
      },
    ]);
    expect(pos.estornosPreCaptura).toEqual([]);

    const pre = computeTikTokStockMovements(pedido({ paidAt: ANTES, updatedAt: ANTES }), inputs());

    expect(pre.vendas).toHaveLength(1);
    expect(pre.estornosPreCaptura).toHaveLength(1);
    expect(pre.estornosPreCaptura[0]?.qtyDelta).toBe(2);
  });

  it("FULFILLMENT_BY_TIKTOK (FBT) gera estorno FBT e não repõe estoque local em cancelamento", () => {
    const fbt = computeTikTokStockMovements(
      pedido({
        fulfillmentType: "FULFILLMENT_BY_TIKTOK",
        status: "CANCELLED",
        paidAt: DEPOIS,
        updatedAt: CANCELADO_DEPOIS,
      }),
      inputs(),
    );

    expect(fbt.vendas).toHaveLength(1);
    expect(fbt.estornosFbt).toHaveLength(1);
    expect(fbt.estornosFbt[0]?.qtyDelta).toBe(2);
    expect(fbt.cancelamentos).toEqual([]);
  });

  it("cancelamento pós-corte (incluindo CANCEL normalizado) repõe estoque; cancelamento pré-corte não duplica reposição", () => {
    const trio = computeTikTokStockMovements(
      pedido({
        status: "CANCEL",
        paidAt: ANTES,
        updatedAt: CANCELADO_DEPOIS,
      }),
      inputs(),
    );

    expect(trio.vendas).toHaveLength(1);
    expect(trio.estornosPreCaptura).toHaveLength(1);
    expect(trio.cancelamentos).toHaveLength(1);
    expect(trio.cancelamentos[0]?.qtyDelta).toBe(2);

    const jaNaPlanilha = computeTikTokStockMovements(
      pedido({
        status: "CANCELLED",
        paidAt: ANTES,
        updatedAt: ANTES,
      }),
      inputs(),
    );

    expect(jaNaPlanilha.cancelamentos).toEqual([]);
  });

  it("falha fechado com RangeError em datas inválidas", () => {
    expect(() =>
      computeTikTokStockMovements(pedido({ paidAt: new Date(Number.NaN) }), inputs()),
    ).toThrow(RangeError);
    expect(() =>
      computeTikTokStockMovements(pedido({ status: "CANCELLED", updatedAt: new Date(Number.NaN) }), inputs()),
    ).toThrow(RangeError);
  });
});
