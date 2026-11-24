import { describe, expect, it, vi } from "vitest";

import { createTikTokShopClient } from "./client.js";
import {
  ORDER_DETAIL_MAX_BATCH,
  ORDER_SEARCH_MAX_PAGE_SIZE,
  aggregateTikTokLineItems,
  getOrderDetail,
  searchOrdersPage,
} from "./orders.js";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const SHOP = { accessToken: "token-vendedor", shopCipher: "ROW_cipher_1" };

function clienteCom(corpo: unknown) {
  const chamadas: { url: URL; init: RequestInit | undefined }[] = [];
  const fetchImpl = vi.fn((url: URL, init?: RequestInit) => {
    chamadas.push({ url, init });

    return Promise.resolve(new Response(JSON.stringify(corpo), { status: 200 }));
  });
  const client = createTikTokShopClient({
    appKey: "chave-teste",
    appSecret: "segredo-teste",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW,
  });

  return { client, chamadas };
}

describe("pedidos do TikTok Shop (§6)", () => {
  it("busca página em POST /order/202309/orders/search, envia filtros no corpo e descarta PII do comprador", async () => {
    const { client, chamadas } = clienteCom({
      code: 0,
      message: "Success",
      request_id: "r-ord-1",
      data: {
        next_page_token: "cursor-2",
        total_count: 12,
        orders: [
          {
            id: "576461413038785752",
            status: "AWAITING_SHIPMENT",
            create_time: 1700000000,
            update_time: 1700000600,
            paid_time: 1700000100,
            fulfillment_type: "FULFILLMENT_BY_SELLER",
            shipping_type: "TIKTOK",
            cpf: "123.456.789-00",
            cpf_name: "Comprador Privado",
            buyer_email: "privado@example.com",
            recipient_address: { full_address: "Rua Secreta 10" },
            payment: {
              currency: "BRL",
              sub_total: "199.90",
              shipping_fee: "15.00",
              total_amount: "214.90",
            },
            line_items: [
              {
                id: "li-1",
                sku_id: "sku-a",
                seller_sku: "CAP-001",
                product_id: "prod-1",
                sale_price: "99.95",
                original_price: "110.00",
                seller_discount: "5.00",
                platform_discount: "5.05",
                is_gift: false,
                display_status: "AWAITING_SHIPMENT",
              },
            ],
          },
        ],
      },
    });

    const page = await searchOrdersPage(client, SHOP, {
      pageSize: 50,
      sortField: "update_time",
      sortOrder: "ASC",
      updateTimeGe: 1700000000,
      updateTimeLt: 1700003600,
      orderStatus: "AWAITING_SHIPMENT",
    });

    expect(page.totalCount).toBe(12);
    expect(page.nextPageToken).toBe("cursor-2");
    expect(page.orders).toHaveLength(1);
    expect(page.orders[0]).toMatchObject({
      id: "576461413038785752",
      status: "AWAITING_SHIPMENT",
      fulfillment_type: "FULFILLMENT_BY_SELLER",
      shipping_type: "TIKTOK",
    });
    // Nenhum dado pessoal do comprador sobrevive ao schema.
    expect(page.orders[0]).not.toHaveProperty("cpf");
    expect(page.orders[0]).not.toHaveProperty("cpf_name");
    expect(page.orders[0]).not.toHaveProperty("buyer_email");
    expect(page.orders[0]).not.toHaveProperty("recipient_address");

    const chamada = chamadas[0];

    expect(chamada?.url.pathname).toBe("/order/202309/orders/search");
    expect(chamada?.url.searchParams.get("page_size")).toBe("50");
    expect(chamada?.url.searchParams.get("sort_field")).toBe("update_time");
    expect(chamada?.url.searchParams.get("sort_order")).toBe("ASC");
    expect(chamada?.url.searchParams.get("shop_cipher")).toBe("ROW_cipher_1");
    expect(JSON.parse(chamada?.init?.body as string)).toEqual({
      update_time_ge: 1700000000,
      update_time_lt: 1700003600,
      order_status: "AWAITING_SHIPMENT",
    });
  });

  it("rejeita pageSize fora da faixa, janela invertida e cursor repetido na paginação", async () => {
    const { client } = clienteCom({
      code: 0,
      data: { next_page_token: "mesmo-cursor", total_count: 1, orders: [] },
    });

    await expect(searchOrdersPage(client, SHOP, { pageSize: 0 })).rejects.toThrow(RangeError);
    await expect(searchOrdersPage(client, SHOP, { pageSize: ORDER_SEARCH_MAX_PAGE_SIZE + 1 })).rejects.toThrow(RangeError);
    await expect(
      searchOrdersPage(client, SHOP, { updateTimeGe: 1700003600, updateTimeLt: 1700003600 }),
    ).rejects.toThrow(RangeError);
    await expect(
      searchOrdersPage(client, SHOP, { createTimeGe: 1700005000, createTimeLt: 1700001000 }),
    ).rejects.toThrow(RangeError);
    await expect(searchOrdersPage(client, SHOP, { pageToken: "mesmo-cursor" })).rejects.toThrow(/cursor repetido/i);
  });

  it("lê detalhe em lote GET /order/202507/orders com deduplicação, limite de 50 IDs e curto-circuito vazio", async () => {
    const { client, chamadas } = clienteCom({
      code: 0,
      data: {
        orders: [
          {
            id: "1001",
            status: "COMPLETED",
            create_time: 1700000000,
            update_time: 1700000500,
            line_items: [],
          },
        ],
      },
    });

    expect(await getOrderDetail(client, SHOP, [])).toEqual([]);
    expect(chamadas).toHaveLength(0);

    const detalhe = await getOrderDetail(client, SHOP, [" 1001 ", "1001"]);

    expect(detalhe).toHaveLength(1);
    expect(chamadas[0]?.url.pathname).toBe("/order/202507/orders");
    expect(chamadas[0]?.url.searchParams.get("ids")).toBe("1001");

    const demais = Array.from({ length: ORDER_DETAIL_MAX_BATCH + 1 }, (_, i) => String(i + 1));

    await expect(getOrderDetail(client, SHOP, demais)).rejects.toThrow(RangeError);
    await expect(getOrderDetail(client, SHOP, ["1001/../../etc"])).rejects.toThrow(RangeError);
  });

  it("agrega line_items (1 linha por unidade) em quantidades por SKU preservando bundle virtual e ausência como null", () => {
    const itens = aggregateTikTokLineItems([
      {
        id: "li-1",
        sku_id: "sku-a",
        seller_sku: " CAP-001 ",
        product_id: "prod-1",
        sale_price: "50.00",
        original_price: "60.00",
        seller_discount: "5.00",
        platform_discount: "5.00",
        is_gift: false,
      },
      {
        id: "li-2",
        sku_id: "sku-a",
        seller_sku: "CAP-001",
        product_id: "prod-1",
        sale_price: "50.00",
        original_price: "60.00",
        seller_discount: "5.00",
        platform_discount: "5.00",
        is_gift: false,
      },
      {
        id: "li-3",
        sku_id: "sku-b",
        seller_sku: "",
        product_id: "prod-2",
        sale_price: null,
        is_gift: true,
        combined_listing_skus: [{ sku_id: "comp-1", seller_sku: "COMP-A", product_id: "p-comp", sku_count: 2 }],
      },
    ]);

    expect(itens).toEqual([
      {
        skuId: "sku-a",
        sellerSku: "CAP-001",
        productId: "prod-1",
        isGift: false,
        quantity: 2,
        lineItemIds: ["li-1", "li-2"],
        salePriceTotal: 100,
        originalPriceTotal: 120,
        sellerDiscountTotal: 10,
        platformDiscountTotal: 10,
        combinedListingSkus: [],
      },
      {
        skuId: "sku-b",
        sellerSku: null,
        productId: "prod-2",
        isGift: true,
        quantity: 1,
        lineItemIds: ["li-3"],
        salePriceTotal: null,
        originalPriceTotal: null,
        sellerDiscountTotal: null,
        platformDiscountTotal: null,
        combinedListingSkus: [{ sku_id: "comp-1", seller_sku: "COMP-A", product_id: "p-comp", sku_count: 2 }],
      },
    ]);
  });
});
