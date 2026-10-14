import { describe, expect, it, vi } from "vitest";

import { fromShopeeAdsDate, getAllCpcAdsDailyPerformance, toShopeeAdsDate } from "./ads.js";
import { createShopeeClient } from "./client.js";

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
  date: "17-03-2021",
  impression: 123456,
  clicks: 123456,
  ctr: 1.23,
  direct_order: 123456,
  broad_order: 123456,
  direct_conversions: 1.23,
  broad_conversions: 1.23,
  direct_item_sold: 123,
  broad_item_sold: 123,
  direct_gmv: 1.23,
  broad_gmv: 1.23,
  expense: 1.23,
  cost_per_conversion: 1.23,
  direct_roas: 1.23,
  broad_roas: 1.23,
};

describe("get_all_cpc_ads_daily_performance (D-449)", () => {
  it("pede o período em DD-MM-AAAA e lê o exemplo oficial", async () => {
    const { client, urls } = clienteCom({ request_id: "x", response: [EXEMPLO] });

    const dias = await getAllCpcAdsDailyPerformance(client, SHOP, { startDate: "2021-03-17", endDate: "2021-03-18" });

    expect(urls[0]?.pathname).toBe("/api/v2/ads/get_all_cpc_ads_daily_performance");
    expect(Object.fromEntries(urls[0]?.searchParams.entries() ?? [])).toMatchObject({ start_date: "17-03-2021", end_date: "18-03-2021" });
    expect(dias[0]).toMatchObject({ date: "17-03-2021", expense: 1.23, broad_gmv: 1.23, direct_order: 123456 });
  });

  it("sem anúncio a lista pode faltar; início igual ao fim é recusado antes de chamar", async () => {
    const { client, urls } = clienteCom({ request_id: "x" });

    expect(await getAllCpcAdsDailyPerformance(client, SHOP, { startDate: "2026-10-01", endDate: "2026-10-14" })).toEqual([]);
    await expect(getAllCpcAdsDailyPerformance(client, SHOP, { startDate: "2026-10-14", endDate: "2026-10-14" })).rejects.toThrow(/início anterior/);
    expect(urls).toHaveLength(1);
  });

  it("converte as datas nos dois sentidos", () => {
    expect(toShopeeAdsDate("2026-10-14")).toBe("14-10-2026");
    expect(fromShopeeAdsDate("14-10-2026")).toBe("2026-10-14");
  });
});
