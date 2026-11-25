import { describe, expect, it } from "vitest";

import {
  classifyTikTokReturnKind,
  isTikTokReturnCompleted,
  normalizeTikTokReturnStatus,
  planTikTokReturnStockReversal,
  projectTikTokReturn,
  tiktokReturnKeyOf,
} from "./returns-projection.js";

describe("D-813 — devoluções, cancelamentos e reversão idempotente de estoque TikTok Shop", () => {
  it("normaliza sufixo _CANCEL -> _CANCELLED e classifica tipos de devolução/reembolso", () => {
    expect(normalizeTikTokReturnStatus("RETURN_OR_REFUND_REQUEST_CANCEL")).toBe("RETURN_OR_REFUND_REQUEST_CANCELLED");
    expect(normalizeTikTokReturnStatus("CANCEL")).toBe("CANCELLED");
    expect(normalizeTikTokReturnStatus("RETURN_OR_REFUND_REQUEST_COMPLETE")).toBe("RETURN_OR_REFUND_REQUEST_COMPLETE");

    expect(classifyTikTokReturnKind("RETURN_AND_REFUND")).toBe("RETORNO_FISICO");
    expect(classifyTikTokReturnKind("RETURN_OR_REFUND")).toBe("RETORNO_FISICO");
    expect(classifyTikTokReturnKind("REFUND_ONLY")).toBe("APENAS_REEMBOLSO");
    expect(classifyTikTokReturnKind("CANCEL")).toBe("CANCELAMENTO");
    expect(classifyTikTokReturnKind("toString")).toBe("DESCONHECIDO");

    expect(isTikTokReturnCompleted("RETURN_OR_REFUND_REQUEST_COMPLETE")).toBe(true);
    expect(isTikTokReturnCompleted("RETURN_OR_REFUND_REQUEST_PENDING")).toBe(false);
    expect(isTikTokReturnCompleted("RETURN_OR_REFUND_REQUEST_CANCEL")).toBe(false);
  });

  it("projeta devolução agregando return_line_items unitários, data de negócio SP e valores opcionais sem PII", () => {
    // 2026-11-24T01:30:00Z = 2026-11-23T22:30:00-03:00 (dia de negócio 2026-11-23 em São Paulo)
    const createEpoch = Math.floor(new Date("2026-11-24T01:30:00.000Z").getTime() / 1000);
    const projected = projectTikTokReturn({
      return_id: "ret-100",
      order_id: "ord-500",
      return_type: "RETURN_AND_REFUND",
      return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE",
      create_time: createEpoch,
      update_time: createEpoch + 3600,
      refund_amount: {
        currency: "BRL",
        refund_total: "199.80",
        refund_subtotal: "180.00",
        refund_shipping_fee: null,
      },
      return_line_items: [
        { product_id: "p1", sku_id: "s1", seller_sku: "CAP-01" },
        { product_id: "p1", sku_id: "s1", seller_sku: "CAP-01" },
        { product_id: "p2", sku_id: "s2", seller_sku: "LUVA-M" },
      ],
    });

    expect(projected).toMatchObject({
      returnId: "ret-100",
      orderId: "ord-500",
      kind: "RETORNO_FISICO",
      completed: true,
      businessDate: "2026-11-23",
      currency: "BRL",
      refundTotalBrl: 199.8,
      refundSubtotalBrl: 180,
      refundShippingBrl: null,
    });
    expect(projected.items).toEqual([
      { productId: "p1", skuId: "s1", sellerSku: "CAP-01", quantity: 2 },
      { productId: "p2", skuId: "s2", sellerSku: "LUVA-M", quantity: 1 },
    ]);
  });

  it("respeita guarda D-497, ignora REFUND_ONLY, FBT, não concluída e pré-corte, e limita reversão ao saldo líquido vendido", () => {
    const occurredAt = new Date("2026-11-24T12:00:00.000Z");
    const saleKey = "tiktok-venda:shop-1:ord-1:0";
    const baseInput = {
      returnId: "ret-1",
      returnType: "RETURN_AND_REFUND",
      returnStatus: "RETURN_OR_REFUND_REQUEST_COMPLETE",
      fulfillmentType: "FULFILLMENT_BY_SELLER",
      orderDeductionEnabled: true,
      occurredAt,
      returnedItems: [{ skuId: "sku-internal-1", quantity: 3 }],
      recordedSales: [{ skuId: "sku-internal-1", qtyDelta: -3, idempotencyKey: saleKey }],
      recordedReversals: [{ idempotencyKey: `cancelamento:${saleKey}`, qtyDelta: 1 }],
      estornadas: new Set<string>(),
      cutoffFor: () => null,
    };

    // Guarda D-497 desligada -> zero movimentos
    expect(planTikTokReturnStockReversal({ ...baseInput, orderDeductionEnabled: false })).toEqual([]);
    // REFUND_ONLY (sem retorno físico) -> zero movimentos
    expect(planTikTokReturnStockReversal({ ...baseInput, returnType: "REFUND_ONLY" })).toEqual([]);
    // FBT (volta para galpão TikTok, não prateleira local) -> zero movimentos
    expect(planTikTokReturnStockReversal({ ...baseInput, fulfillmentType: "FULFILLMENT_BY_TIKTOK" })).toEqual([]);
    // Ainda pendente -> zero movimentos
    expect(planTikTokReturnStockReversal({ ...baseInput, returnStatus: "RETURN_OR_REFUND_REQUEST_PENDING" })).toEqual(
      [],
    );
    // Venda já estornada (pré-captura ou FBT) -> zero movimentos
    expect(planTikTokReturnStockReversal({ ...baseInput, estornadas: new Set([saleKey]) })).toEqual([]);
    // Ocorrência anterior ao corte UpSeller -> zero movimentos
    expect(
      planTikTokReturnStockReversal({
        ...baseInput,
        cutoffFor: () => ({
          exportedAt: new Date("2026-11-24T15:00:00.000Z"),
          capturedAt: new Date("2026-11-24T15:00:00.000Z"),
          importedAt: new Date("2026-11-24T16:00:00.000Z"),
          reconciledAt: null,
        }),
      }),
    ).toEqual([]);

    // Caso feliz: vendeu 3, já cancelou 1 -> devolução física repõe apenas as 2 unidades restantes!
    expect(planTikTokReturnStockReversal(baseInput)).toEqual([
      {
        skuId: "sku-internal-1",
        qtyDelta: 2,
        idempotencyKey: tiktokReturnKeyOf("ret-1", saleKey),
        occurredAt,
      },
    ]);
  });

  it("falha fechado (RangeError) em occurredAt inválida ou returnId vazio", () => {
    expect(() =>
      planTikTokReturnStockReversal({
        returnId: "ret-1",
        returnType: "RETURN_AND_REFUND",
        returnStatus: "RETURN_OR_REFUND_REQUEST_COMPLETE",
        fulfillmentType: "FULFILLMENT_BY_SELLER",
        orderDeductionEnabled: true,
        occurredAt: new Date("invalid"),
        returnedItems: [{ skuId: "sku-1", quantity: 1 }],
        recordedSales: [],
        recordedReversals: [],
        estornadas: new Set(),
        cutoffFor: () => null,
      }),
    ).toThrow(RangeError);
  });
});
