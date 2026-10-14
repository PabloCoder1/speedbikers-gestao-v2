import { describe, expect, it, vi } from "vitest";

import { ShopeeApiError, createShopeeClient } from "./client.js";
import { getEscrowListPage, isEscrowListEmpty } from "./escrow-list.js";

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

// O exemplo da referência oficial (14/10/2026).
const EXEMPLO = {
  request_id: "8d7de8c04b4cd5f3df9e4aa98c2d87d1",
  error: "",
  message: "",
  response: {
    more: true,
    escrow_list: [
      { order_sn: "220415N6SB140P", payout_amount: 57334, escrow_release_time: 1651849648 },
      { order_sn: "220415M9J6GHBP", payout_amount: 5930, escrow_release_time: 1651849648 },
    ],
  },
};

describe("get_escrow_list (D-451)", () => {
  it("lê o exemplo oficial e manda a janela de liberação, 100 por página", async () => {
    const { client, urls } = clienteCom(EXEMPLO);
    const pagina = await getEscrowListPage(client, SHOP, { releaseTimeFrom: 1651680000, releaseTimeTo: 1651939200, pageNo: 1 });

    expect(pagina.more).toBe(true);
    expect(pagina.releases).toEqual([
      { order_sn: "220415N6SB140P", payout_amount: 57334, escrow_release_time: 1651849648 },
      { order_sn: "220415M9J6GHBP", payout_amount: 5930, escrow_release_time: 1651849648 },
    ]);
    expect(urls[0]?.pathname).toBe("/api/v2/payment/get_escrow_list");
    expect(urls[0]?.searchParams.get("release_time_from")).toBe("1651680000");
    expect(urls[0]?.searchParams.get("release_time_to")).toBe("1651939200");
    expect(urls[0]?.searchParams.get("page_size")).toBe("100");
    expect(urls[0]?.searchParams.get("page_no")).toBe("1");
  });

  it("página sem lista é vazia; valor ausente fica nulo", async () => {
    const vazia = await getEscrowListPage(clienteCom({ request_id: "r", response: { more: false } }).client, SHOP, {
      releaseTimeFrom: 1,
      releaseTimeTo: 2,
      pageNo: 1,
    });

    expect(vazia).toEqual({ releases: [], more: false });

    const semValor = await getEscrowListPage(
      clienteCom({ request_id: "r", response: { more: false, escrow_list: [{ order_sn: "X", escrow_release_time: 10 }] } }).client,
      SHOP,
      { releaseTimeFrom: 1, releaseTimeTo: 2, pageNo: 1 },
    );

    expect(semValor.releases).toEqual([{ order_sn: "X", escrow_release_time: 10 }]);
  });

  it("nada liberado é vazio; 'parse data failed' não é", () => {
    const erro = (code: string, message: string) => new ShopeeApiError(message, { status: 200, code, requestId: null });

    expect(isEscrowListEmpty(erro("income_not_found", "The escrow income not found."))).toBe(true);
    expect(isEscrowListEmpty(erro("common.error_not_found", "x"))).toBe(true);
    expect(isEscrowListEmpty(erro("error_data", "data not exist"))).toBe(true);
    expect(isEscrowListEmpty(erro("error_data", "parse data failed"))).toBe(false);
    expect(isEscrowListEmpty(erro("error_param", "parameter invalid"))).toBe(false);
    expect(isEscrowListEmpty(new Error("rede"))).toBe(false);
  });
});
