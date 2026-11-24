import { describe, expect, it, vi } from "vitest";

import { createTikTokShopClient } from "./client.js";
import {
  RETURN_SEARCH_MAX_PAGE_SIZE,
  RETURN_SEARCH_MIN_PAGE_SIZE,
  normalizeTikTokCancelStatus,
  searchCancellationsPage,
  searchReturnsPage,
} from "./returns.js";

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

describe("devoluções e cancelamentos do TikTok Shop (§9)", () => {
  it("busca devoluções POST /return_refund/202602/returns/search respeitando página 10..50 e descartando PII", async () => {
    const { client, chamadas } = clienteCom({
      code: 0,
      data: {
        next_page_token: "ret-2",
        total_count: 1,
        return_orders: [
          {
            return_id: "ret-1",
            order_id: "576461413038785752",
            return_type: "RETURN_AND_REFUND",
            return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
            create_time: 1700000000,
            update_time: 1700000500,
            buyer_user_id: "buyer-secret",
            refund_amount: { currency: "BRL", refund_total: "99.95" },
            return_line_items: [{ sku_id: "sku-a", seller_sku: "CAP-001", product_id: "prod-1" }],
          },
        ],
      },
    });

    const page = await searchReturnsPage(client, SHOP, {
      pageSize: 25,
      returnTypes: ["RETURN_AND_REFUND"],
      updateTimeGe: 1700000000,
      updateTimeLt: 1700003600,
    });

    expect(page.totalCount).toBe(1);
    expect(page.nextPageToken).toBe("ret-2");
    expect(page.returns[0]?.return_id).toBe("ret-1");
    expect(page.returns[0]).not.toHaveProperty("buyer_user_id");
    expect(chamadas[0]?.url.pathname).toBe("/return_refund/202602/returns/search");

    await expect(searchReturnsPage(client, SHOP, { pageSize: RETURN_SEARCH_MIN_PAGE_SIZE - 1 })).rejects.toThrow(
      RangeError,
    );
    await expect(searchReturnsPage(client, SHOP, { pageSize: RETURN_SEARCH_MAX_PAGE_SIZE + 1 })).rejects.toThrow(
      RangeError,
    );
    await expect(searchReturnsPage(client, SHOP, { pageToken: "ret-2" })).rejects.toThrow(/cursor repetido/i);
  });

  it("busca cancelamentos POST /return_refund/202602/cancellations/search e normaliza sufixo _CANCEL/_CANCELLED", async () => {
    const { client, chamadas } = clienteCom({
      code: 0,
      data: {
        next_page_token: "",
        total_count: 1,
        cancellations: [
          {
            cancel_id: "can-1",
            order_id: "576461413038785752",
            cancel_type: "BUYER_CANCEL",
            cancel_status: "CANCELLATION_REQUEST_CANCEL",
            cancel_reason: "buyer_changed_mind",
            create_time: 1700000000,
            update_time: 1700000200,
            buyer_user_id: "buyer-secret",
            refund_amount: { currency: "BRL", refund_total: "99.95" },
          },
        ],
      },
    });

    const page = await searchCancellationsPage(client, SHOP, { pageSize: 20, orderIds: ["576461413038785752"] });

    expect(page.nextPageToken).toBeNull();
    expect(page.cancellations[0]?.cancel_id).toBe("can-1");
    expect(page.cancellations[0]).not.toHaveProperty("buyer_user_id");
    expect(chamadas[0]?.url.pathname).toBe("/return_refund/202602/cancellations/search");

    expect(normalizeTikTokCancelStatus("CANCEL")).toBe("CANCELLED");
    expect(normalizeTikTokCancelStatus("CANCELLATION_REQUEST_CANCEL")).toBe("CANCELLATION_REQUEST_CANCELLED");
    expect(normalizeTikTokCancelStatus("CANCELLATION_REQUEST_CANCELLED")).toBe("CANCELLATION_REQUEST_CANCELLED");
    expect(normalizeTikTokCancelStatus("AWAITING_SHIPMENT")).toBe("AWAITING_SHIPMENT");
  });
});
