import { describe, expect, it, vi } from "vitest";

import { createShopeeClient } from "./client.js";
import { getReturnListPage } from "./returns.js";

const SHOP = { accessToken: "tok", shopId: 54804 };

function clienteCom(corpo: unknown) {
  const urls: URL[] = [];
  const fetchImpl = vi.fn((url: URL) => {
    urls.push(url);

    return Promise.resolve(new Response(JSON.stringify(corpo), { status: 200 }));
  });

  return {
    client: createShopeeClient({
      environment: "sandbox",
      partnerId: 1248019,
      partnerKey: "chave-de-teste-nao-real",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date("2026-10-14T15:00:00.000Z"),
    }),
    urls,
  };
}

// O exemplo da referência oficial (14/10/2026), com o comprador e as fotos.
const EXEMPLO = {
  image: ["https://cf.shopee.sg/file/x"],
  reason: "PHYSICAL_DMG",
  text_reason: "texto livre do comprador",
  reassessed_request_reason: "NONE",
  return_sn: "200203171852695",
  refund_amount: 1409,
  currency: "SGD",
  create_time: 1580721513,
  update_time: 1580729377,
  status: "CANCELLED",
  due_date: 1580721513,
  tracking_number: "RNSHS00177569",
  dispute_reason: ["UNKNOWN"],
  dispute_text_reason: ["reason"],
  needs_logistics: true,
  amount_before_discount: 1409,
  user: { username: "abcdefg", email: "***r1@shopee.com", portrait: "https://cf.shopee.sg/file/y" },
  item: [
    {
      model_id: 0,
      name: "agsabdmnambd",
      images: ["https://cf.shopee.sg/file/z"],
      amount: 1,
      item_price: 1409.9,
      is_add_on_deal: false,
      is_main_item: false,
      add_on_deal_id: 0,
      item_id: 2147533133,
      item_sku: "USB",
      variation_sku: "RED",
    },
  ],
  order_sn: "200203C6W0AR27",
  return_ship_due_date: 1655438336,
  return_seller_due_date: 1655438336,
  negotiation_status: "PENDING_RESPOND",
  seller_proof_status: "PENDING",
  seller_compensation_status: "PENDING_REQUEST",
  return_refund_type: "RRAOC",
  return_solution: 0,
  return_refund_request_type: 0,
  validation_type: "seller_validation",
};

describe("get_return_list (D-447)", () => {
  it("pede a janela por update_time, 100 por página, e lê o exemplo oficial sem o comprador", async () => {
    const { client, urls } = clienteCom({ error: "", response: { more: true, return: [EXEMPLO] } });

    const pagina = await getReturnListPage(client, SHOP, { timeFrom: 1760000000, timeTo: 1761000000, pageNo: 0 });

    expect(urls[0]?.pathname).toBe("/api/v2/returns/get_return_list");
    expect(Object.fromEntries(urls[0]?.searchParams.entries() ?? [])).toMatchObject({
      page_no: "0",
      page_size: "100",
      update_time_from: "1760000000",
      update_time_to: "1761000000",
    });
    expect(pagina.more).toBe(true);
    expect(pagina.returns[0]).toMatchObject({ return_sn: "200203171852695", order_sn: "200203C6W0AR27", status: "CANCELLED", refund_amount: 1409 });
    // Comprador, fotos e texto livre ficam de fora.
    expect(pagina.returns[0]).not.toHaveProperty("user");
    expect(pagina.returns[0]).not.toHaveProperty("image");
    expect(pagina.returns[0]).not.toHaveProperty("text_reason");
    expect(pagina.returns[0]?.item?.[0]).not.toHaveProperty("images");
  });

  it("página vazia pode vir sem a lista", async () => {
    const { client } = clienteCom({ error: "", response: { more: false } });

    expect(await getReturnListPage(client, SHOP, { timeFrom: 1, timeTo: 2, pageNo: 0 })).toEqual({ returns: [], more: false });
  });
});
