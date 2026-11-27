import { describe, expect, it } from "vitest";

import {
  TIKTOK_FBT_FLAG,
  classifyTikTokOrderLifecycle,
  isTikTokFulfilledByPlatform,
  projectTikTokOrder,
} from "./order-projection.js";

describe("projeção de pedidos do TikTok Shop (D-809, docs/TIKTOK_SHOP.md §6/§13)", () => {
  it("classifica os 9 status oficiais e normaliza CANCEL do webhook", () => {
    expect(classifyTikTokOrderLifecycle("UNPAID")).toBe("PENDENTE_PAGAMENTO");
    expect(classifyTikTokOrderLifecycle("ON_HOLD")).toBe("JANELA_ARREPENDIMENTO");
    expect(classifyTikTokOrderLifecycle("AWAITING_SHIPMENT")).toBe("VALIDA");
    expect(classifyTikTokOrderLifecycle("PARTIALLY_SHIPPING")).toBe("VALIDA");
    expect(classifyTikTokOrderLifecycle("AWAITING_COLLECTION")).toBe("VALIDA");
    expect(classifyTikTokOrderLifecycle("IN_TRANSIT")).toBe("VALIDA");
    expect(classifyTikTokOrderLifecycle("DELIVERED")).toBe("VALIDA");
    expect(classifyTikTokOrderLifecycle("COMPLETED")).toBe("VALIDA");
    expect(classifyTikTokOrderLifecycle("CANCELLED")).toBe("CANCELADA");
    expect(classifyTikTokOrderLifecycle("CANCEL")).toBe("CANCELADA");
    expect(classifyTikTokOrderLifecycle("NOVO_STATUS_FUTURO")).toBe("DESCONHECIDO");
  });

  it("distingue FULFILLMENT_BY_TIKTOK (FBT) de vendedor local e trata valor ausente como conservador", () => {
    expect(TIKTOK_FBT_FLAG).toBe("FULFILLMENT_BY_TIKTOK");
    expect(isTikTokFulfilledByPlatform("FULFILLMENT_BY_TIKTOK")).toBe(true);
    expect(isTikTokFulfilledByPlatform("FULFILLMENT_BY_SELLER")).toBe(false);
    expect(isTikTokFulfilledByPlatform(null)).toBe(false);
    expect(isTikTokFulfilledByPlatform("OUTRO")).toBe(false);
  });

  it("projeta pedido pago com data de negócio em São Paulo, agrega unidades por SKU e preserva bundles virtuais", () => {
    // 2026-11-24T01:30:00Z = 2026-11-23 22:30 BRT (dia de negócio anterior!)
    const paidEpoch = Math.floor(Date.parse("2026-11-24T01:30:00.000Z") / 1000);
    const createdEpoch = paidEpoch - 600;
    const updatedEpoch = paidEpoch + 300;

    const proj = projectTikTokOrder({
      id: "576461413038785752",
      status: "AWAITING_SHIPMENT",
      createTime: createdEpoch,
      updateTime: updatedEpoch,
      paidTime: paidEpoch,
      fulfillmentType: "FULFILLMENT_BY_SELLER",
      shippingType: "TIKTOK",
      payment: {
        currency: "BRL",
        subTotal: "199.90",
        shippingFee: "15.00",
        totalAmount: "214.90",
      },
      lineItems: [
        {
          id: "li-1",
          skuId: "sku-a",
          sellerSku: " CAP-001 ",
          productId: "prod-1",
          salePrice: "99.95",
          originalPrice: "110.00",
          sellerDiscount: "5.00",
          platformDiscount: "5.05",
          isGift: false,
        },
        {
          id: "li-2",
          skuId: "sku-a",
          sellerSku: "CAP-001",
          productId: "prod-1",
          salePrice: "99.95",
          originalPrice: "110.00",
          sellerDiscount: "5.00",
          platformDiscount: "5.05",
          isGift: false,
        },
        {
          id: "li-3",
          skuId: "sku-bundle",
          sellerSku: "KIT-2X",
          productId: "prod-2",
          salePrice: null,
          isGift: false,
          combinedListingSkus: [{ skuId: "c1", sellerSku: "COMP-1", productId: "pc1", skuCount: 2 }],
        },
      ],
    });

    expect(proj.orderId).toBe("576461413038785752");
    expect(proj.lifecycle).toBe("VALIDA");
    expect(proj.fulfillmentChannel).toBe("LOCAL");
    expect(proj.businessDate).toBe("2026-11-23");
    expect(proj.paidAt?.toISOString()).toBe("2026-11-24T01:30:00.000Z");
    expect(proj.grossAmount).toBe(214.9);
    expect(proj.subtotalAmount).toBe(199.9);
    expect(proj.shippingFeeAmount).toBe(15);
    expect(proj.currency).toBe("BRL");
    expect(proj.totalUnits).toBe(3);
    expect(proj.items).toEqual([
      {
        position: 0,
        skuId: "sku-a",
        sellerSku: "CAP-001",
        productId: "prod-1",
        isGift: false,
        quantity: 2,
        lineItemIds: ["li-1", "li-2"],
        salePriceTotal: 199.9,
        originalPriceTotal: 220,
        sellerDiscountTotal: 10,
        platformDiscountTotal: 10.1,
        combinedListingSkus: [],
      },
      {
        position: 1,
        skuId: "sku-bundle",
        sellerSku: "KIT-2X",
        productId: "prod-2",
        isGift: false,
        quantity: 1,
        lineItemIds: ["li-3"],
        salePriceTotal: null,
        originalPriceTotal: null,
        sellerDiscountTotal: null,
        platformDiscountTotal: null,
        combinedListingSkus: [{ skuId: "c1", sellerSku: "COMP-1", productId: "pc1", skuCount: 2 }],
      },
    ]);
  });

  it("rejeita timestamps inválidos ou fora da faixa segura e preserva ausência de pagamento como null", () => {
    const baseEpoch = Math.floor(Date.parse("2026-11-24T15:00:00.000Z") / 1000);
    const semPagamento = projectTikTokOrder({
      id: "ord-unpaid",
      status: "UNPAID",
      createTime: baseEpoch,
      updateTime: baseEpoch,
      paidTime: null,
      fulfillmentType: null,
      shippingType: null,
      payment: null,
      lineItems: [],
    });

    expect(semPagamento.lifecycle).toBe("PENDENTE_PAGAMENTO");
    expect(semPagamento.paidAt).toBeNull();
    expect(semPagamento.fulfillmentChannel).toBe("DESCONHECIDO");
    expect(semPagamento.grossAmount).toBeNull();
    expect(semPagamento.businessDate).toBe("2026-11-24");

    expect(() =>
      projectTikTokOrder({
        id: "ord-bad",
        status: "COMPLETED",
        createTime: Number.NaN,
        updateTime: baseEpoch,
        lineItems: [],
      }),
    ).toThrow(RangeError);

    expect(() =>
      projectTikTokOrder({
        id: "   ",
        status: "COMPLETED",
        createTime: baseEpoch,
        updateTime: baseEpoch,
        lineItems: [],
      }),
    ).toThrow(RangeError);
  });
});
