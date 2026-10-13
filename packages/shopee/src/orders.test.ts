import { describe, expect, it, vi } from "vitest";

import { isDefinitiveRefreshRefusal } from "./auth.js";
import { ShopeeApiError, createShopeeClient } from "./client.js";
import { getOrderDetail, getOrderListPage } from "./orders.js";

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
      now: () => new Date("2026-10-13T15:00:00.000Z"),
    }),
    urls,
  };
}

describe("get_order_list (D-426)", () => {
  it("pede a janela por update_time, 100 por página, e devolve o cursor só quando há mais", async () => {
    const { client, urls } = clienteCom({
      error: "",
      response: { more: true, next_cursor: "20", order_list: [{ order_sn: "A1" }, { order_sn: "A2" }] },
    });

    const pagina = await getOrderListPage(client, SHOP, {
      timeRangeField: "update_time",
      timeFrom: 1760000000,
      timeTo: 1761000000,
      cursor: "10",
    });

    expect(pagina).toEqual({ orderSns: ["A1", "A2"], nextCursor: "20" });
    expect(urls[0]?.pathname).toBe("/api/v2/order/get_order_list");
    expect(Object.fromEntries(urls[0]?.searchParams.entries() ?? [])).toMatchObject({
      time_range_field: "update_time",
      time_from: "1760000000",
      time_to: "1761000000",
      page_size: "100",
      cursor: "10",
    });

    const fim = clienteCom({ error: "", response: { more: false, next_cursor: "", order_list: [] } });

    expect(await getOrderListPage(fim.client, SHOP, { timeRangeField: "update_time", timeFrom: 1, timeTo: 2 })).toEqual({
      orderSns: [],
      nextCursor: null,
    });
    expect(fim.urls[0]?.searchParams.has("cursor")).toBe(false);
  });
});

describe("get_order_detail (D-426)", () => {
  it("pede itens e valores, nada do comprador, e lê o pedido sem pagamento com total nulo", async () => {
    const { client, urls } = clienteCom({
      error: "",
      response: {
        order_list: [
          {
            order_sn: "A1",
            order_status: "UNPAID",
            currency: "BRL",
            create_time: 1760000000,
            update_time: 1760000100,
            item_list: [{ item_id: 9, item_sku: "SKU-9", model_id: 0, model_quantity_purchased: 2 }],
          },
        ],
      },
    });

    const pedidos = await getOrderDetail(client, SHOP, ["A1"]);
    const campos = urls[0]?.searchParams.get("response_optional_fields") ?? "";

    expect(pedidos[0]).toMatchObject({ order_sn: "A1", order_status: "UNPAID" });
    // Antes do pagamento a Shopee não manda o total: fica ausente, nunca zero.
    expect(pedidos[0]?.total_amount).toBeUndefined();
    expect(urls[0]?.searchParams.get("order_sn_list")).toBe("A1");
    expect(campos.split(",")).toContain("item_list");
    expect(campos).not.toMatch(/buyer|recipient/);
  });

  it("nenhum pedido não chama; mais de 50 recusa antes de chamar", async () => {
    const { client, urls } = clienteCom({});

    expect(await getOrderDetail(client, SHOP, [])).toEqual([]);
    await expect(getOrderDetail(client, SHOP, Array.from({ length: 51 }, (_, i) => `S${String(i)}`))).rejects.toThrow(
      /50/,
    );
    expect(urls).toEqual([]);
  });
});

describe("recusa definitiva da renovação (D-426)", () => {
  const erro = (code: string | null, status = 200) => new ShopeeApiError("x", { status, code, requestId: null });

  it("refresh vencido, acesso vencido, loja banida ou desligada: a loja precisa reautorizar", () => {
    for (const code of ["refresh_token_expired", "shop_access_expired", "shop_banned", "shop_no_linked", "error_auth"]) {
      expect(isDefinitiveRefreshRefusal(erro(code))).toBe(true);
    }
  });

  it("servidor, rede, 5xx e erro que não é da Shopee são passageiros", () => {
    expect(isDefinitiveRefreshRefusal(erro("error_server"))).toBe(false);
    expect(isDefinitiveRefreshRefusal(erro(null, 503))).toBe(false);
    expect(isDefinitiveRefreshRefusal(new Error("timeout"))).toBe(false);
  });
});
