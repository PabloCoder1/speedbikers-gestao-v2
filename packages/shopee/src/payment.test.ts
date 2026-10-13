import { describe, expect, it } from "vitest";

import { ShopeeApiError, createShopeeClient } from "./client.js";
import { getEscrowDetail, isEscrowUnavailable } from "./payment.js";

const SHOP = { accessToken: "tok", shopId: 54804 };

function clienteCom(corpo: unknown) {
  const urls: URL[] = [];
  const fetchImpl = (url: URL) => {
    urls.push(url);

    return Promise.resolve(new Response(JSON.stringify(corpo), { status: 200 }));
  };

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

describe("get_escrow_detail (D-427)", () => {
  it("pede um pedido e devolve o order_income inteiro, sem o comprador; campo ausente fica ausente", async () => {
    const { client, urls } = clienteCom({
      error: "",
      response: {
        order_sn: "A1",
        buyer_user_name: "comprador",
        return_order_sn_list: [],
        order_income: {
          escrow_amount: 81.4,
          commission_fee: 16.1,
          service_fee: 4,
          final_shipping_fee: -12.5,
          pay_per_sale: 0,
          items: [{ item_id: 9 }],
        },
      },
    });

    const detalhe = await getEscrowDetail(client, SHOP, "A1");

    expect(urls[0]?.pathname).toBe("/api/v2/payment/get_escrow_detail");
    expect(urls[0]?.searchParams.get("order_sn")).toBe("A1");
    expect(detalhe).toEqual({
      orderSn: "A1",
      returnOrderSns: [],
      orderIncome: {
        escrow_amount: 81.4,
        commission_fee: 16.1,
        service_fee: 4,
        final_shipping_fee: -12.5,
        // Componente que a V3 não lê em coluna também fica guardado.
        pay_per_sale: 0,
        items: [{ item_id: 9 }],
      },
    });
    expect(JSON.stringify(detalhe)).not.toContain("comprador");
    expect(detalhe.orderIncome.net_commission_fee).toBeUndefined();
  });

  it("pedido que a Shopee não acha é 'sem financeiro'; servidor e parâmetro não são", () => {
    const erro = (code: string) => new ShopeeApiError("x", { status: 200, code, requestId: null });

    expect(isEscrowUnavailable(erro("order_not_found"))).toBe(true);
    expect(isEscrowUnavailable(erro("error_data"))).toBe(true);
    expect(isEscrowUnavailable(erro("error_server"))).toBe(false);
    expect(isEscrowUnavailable(erro("error_param"))).toBe(false);
    expect(isEscrowUnavailable(new Error("order_not_found"))).toBe(false);
  });

  it("error_network da Shopee é passageiro, como error_server", () => {
    expect(new ShopeeApiError("x", { status: 200, code: "error_network", requestId: null }).errorClass).toBe("retryable");
    expect(new ShopeeApiError("x", { status: 200, code: "error_param", requestId: null }).errorClass).toBe("not_retryable");
  });
});
