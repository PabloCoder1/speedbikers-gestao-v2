import { describe, expect, it, vi } from "vitest";

import { createTikTokShopClient } from "./client.js";
import {
  INVENTORY_SEARCH_MAX_PRODUCTS,
  INVENTORY_SEARCH_MAX_SKUS,
  PRODUCT_SEARCH_MAX_PAGE_SIZE,
  getProductDetail,
  searchInventory,
  searchProductsPage,
} from "./products.js";

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

describe("catálogo e estoque do TikTok Shop (§8)", () => {
  it("busca catálogo POST /product/202502/products/search com filtros e validações", async () => {
    const { client, chamadas } = clienteCom({
      code: 0,
      data: {
        next_page_token: "p-2",
        total_count: 1,
        products: [
          {
            id: "1729592969712207008",
            title: "Capacete Pro",
            status: "ACTIVATE",
            create_time: 1700000000,
            update_time: 1700000500,
            skus: [
              {
                id: "1729592969712207009",
                seller_sku: "CAP-001",
                price: { currency: "BRL", tax_exclusive_price: "199.90", sale_price: "179.90" },
                inventory: [{ warehouse_id: "wh-1", quantity: 14 }],
              },
            ],
          },
        ],
      },
    });

    const page = await searchProductsPage(client, SHOP, {
      pageSize: 50,
      status: "ACTIVATE",
      sellerSkus: ["CAP-001"],
      updateTimeGe: 1700000000,
      updateTimeLe: 1700001000,
    });

    expect(page.totalCount).toBe(1);
    expect(page.nextPageToken).toBe("p-2");
    expect(page.products[0]?.skus?.[0]?.seller_sku).toBe("CAP-001");
    expect(chamadas[0]?.url.pathname).toBe("/product/202502/products/search");
    expect(JSON.parse(chamadas[0]?.init?.body as string)).toEqual({
      status: "ACTIVATE",
      seller_skus: ["CAP-001"],
      update_time_ge: 1700000000,
      update_time_le: 1700001000,
    });

    await expect(searchProductsPage(client, SHOP, { pageSize: PRODUCT_SEARCH_MAX_PAGE_SIZE + 1 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      searchProductsPage(client, SHOP, { updateTimeGe: 1700002000, updateTimeLe: 1700001000 }),
    ).rejects.toThrow(RangeError);
    await expect(searchProductsPage(client, SHOP, { pageToken: "p-2" })).rejects.toThrow(/cursor repetido/i);
  });

  it("lê detalhe GET /product/202309/products/{product_id} e rejeita ID inseguro", async () => {
    const { client, chamadas } = clienteCom({
      code: 0,
      data: {
        id: "1729592969712207008",
        title: "Capacete Pro",
        status: "FROZEN",
        skus: [{ id: "sku-1", seller_sku: "CAP-001", inventory: [{ warehouse_id: "wh-1", quantity: 0 }] }],
      },
    });

    const product = await getProductDetail(client, SHOP, "1729592969712207008");

    expect(product.status).toBe("FROZEN");
    expect(chamadas[0]?.url.pathname).toBe("/product/202309/products/1729592969712207008");
    await expect(getProductDetail(client, SHOP, "../bad")).rejects.toThrow(RangeError);
  });

  it("consulta estoque POST /product/202309/inventory/search respeitando tetos de 100 produtos / 600 SKUs", async () => {
    const { client, chamadas } = clienteCom({
      code: 0,
      data: {
        inventory: [
          {
            product_id: "prod-1",
            skus: [
              {
                id: "sku-1",
                seller_sku: "CAP-001",
                total_available_quantity: 12,
                total_committed_quantity: 2,
                warehouse_inventory: [{ warehouse_id: "wh-1", available_quantity: 12, committed_quantity: 2 }],
              },
            ],
          },
        ],
      },
    });

    const res = await searchInventory(client, SHOP, { productIds: ["prod-1", "prod-1"] });

    expect(res).toHaveLength(1);
    expect(res[0]?.skus?.[0]?.total_available_quantity).toBe(12);
    expect(chamadas[0]?.url.pathname).toBe("/product/202309/inventory/search");
    expect(JSON.parse(chamadas[0]?.init?.body as string)).toEqual({ product_ids: ["prod-1"] });

    await expect(searchInventory(client, SHOP, {})).rejects.toThrow(RangeError);
    await expect(
      searchInventory(client, SHOP, {
        productIds: Array.from({ length: INVENTORY_SEARCH_MAX_PRODUCTS + 1 }, (_, i) => `p-${String(i)}`),
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      searchInventory(client, SHOP, {
        skuIds: Array.from({ length: INVENTORY_SEARCH_MAX_SKUS + 1 }, (_, i) => `s-${String(i)}`),
      }),
    ).rejects.toThrow(RangeError);
  });
});
