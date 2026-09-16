import { describe, expect, it, vi } from "vitest";

import { createMercadoLivreClient } from "./http-client.js";
import {
  fetchProductAdsAdvertiser,
  fetchProductAdsCampaignDailyMetrics,
  fetchProductAdsCampaigns,
} from "./product-ads.js";

interface Chamada {
  url: URL;
  headers: Record<string, string>;
}

function cliente(respostas: { status: number; corpo: unknown }[], chamadas: Chamada[] = []) {
  let i = 0;
  const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: new URL(url as string | URL), headers: init?.headers as Record<string, string> });
    const r = respostas[Math.min(i, respostas.length - 1)] ?? { status: 500, corpo: null };

    i += 1;

    return Promise.resolve(new Response(JSON.stringify(r.corpo), { status: r.status }));
  });

  return createMercadoLivreClient({ fetchImpl: fetchImpl as unknown as typeof fetch, maxAttempts: 1, sleep: () => Promise.resolve() });
}

describe("fetchProductAdsAdvertiser", () => {
  it("pede PADS com Api-Version 1 e devolve o anunciante do MLB", async () => {
    const chamadas: Chamada[] = [];
    const c = cliente(
      [
        {
          status: 200,
          corpo: {
            advertisers: [
              { advertiser_id: 111, site_id: "MLM", advertiser_name: "x", account_name: "y" },
              { advertiser_id: 222, site_id: "MLB", advertiser_name: "SB", account_name: "MLB - SB" },
            ],
          },
        },
      ],
      chamadas,
    );

    await expect(fetchProductAdsAdvertiser(c, "tok")).resolves.toEqual({
      status: "habilitado",
      advertiserId: 222,
      siteId: "MLB",
    });
    expect(chamadas[0]?.url.pathname).toBe("/advertising/advertisers");
    expect(chamadas[0]?.url.searchParams.get("product_id")).toBe("PADS");
    expect(chamadas[0]?.headers["Api-Version"]).toBe("1");
    expect(chamadas[0]?.headers.authorization).toBe("Bearer tok");
  });

  it("404 'No permissions found' é conta SEM Product Ads — estado, não erro", async () => {
    const c = cliente([{ status: 404, corpo: { message: "No permissions found for user_id" } }]);

    await expect(fetchProductAdsAdvertiser(c, "tok")).resolves.toEqual({ status: "nao_habilitado" });
  });

  it("outras falhas continuam sendo falha", async () => {
    const c = cliente([{ status: 403, corpo: { message: "forbidden" } }]);

    await expect(fetchProductAdsAdvertiser(c, "tok")).rejects.toThrow();
  });
});

describe("fetchProductAdsCampaigns", () => {
  it("pagina até o total, com api-version 2", async () => {
    const chamadas: Chamada[] = [];
    const campanha = (id: number) => ({ id, name: `C${String(id)}`, status: "active", strategy: "PROFITABILITY", budget: 28, roas_target: 11.1 });
    const c = cliente(
      [
        { status: 200, corpo: { paging: { total: 51, offset: 0, limit: 50 }, results: Array.from({ length: 50 }, (_x, i) => campanha(i + 1)) } },
        { status: 200, corpo: { paging: { total: 51, offset: 50, limit: 50 }, results: [campanha(51)] } },
      ],
      chamadas,
    );

    const campanhas = await fetchProductAdsCampaigns(c, "tok", "MLB", 222);

    expect(campanhas).toHaveLength(51);
    expect(chamadas).toHaveLength(2);
    expect(chamadas[0]?.url.pathname).toBe("/advertising/MLB/advertisers/222/product_ads/campaigns/search");
    expect(chamadas[1]?.url.searchParams.get("offset")).toBe("50");
    expect(chamadas[0]?.headers["api-version"]).toBe("2");
  });
});

describe("fetchProductAdsCampaignDailyMetrics", () => {
  it("pede DAILY com as métricas e valida cada dia", async () => {
    const chamadas: Chamada[] = [];
    const dia = {
      date: "2026-09-15",
      clicks: 12,
      prints: 900,
      ctr: 1.3,
      cost: 18.4,
      cpc: 1.53,
      acos: 9.1,
      direct_amount: 150,
      indirect_amount: 52,
      total_amount: 202,
      direct_units_quantity: 1,
      indirect_units_quantity: 1,
      units_quantity: 2,
      organic_units_quantity: 3,
      organic_units_amount: 300,
    };
    const c = cliente([{ status: 200, corpo: [dia] }], chamadas);

    const dias = await fetchProductAdsCampaignDailyMetrics(c, "tok", "MLB", 355189450, "2026-09-01", "2026-09-15");

    expect(dias).toHaveLength(1);
    expect(dias[0]?.cost).toBe(18.4);
    expect(chamadas[0]?.url.pathname).toBe("/advertising/MLB/product_ads/campaigns/355189450");
    expect(chamadas[0]?.url.searchParams.get("aggregation_type")).toBe("DAILY");
    expect(chamadas[0]?.url.searchParams.get("metrics")).toContain("cost");
  });

  it("aceita a lista embrulhada em results ou metrics (a resposta real de produção era objeto)", async () => {
    const dia = {
      date: "2026-09-15",
      clicks: 1,
      prints: 10,
      cost: 2,
      direct_amount: 5,
      indirect_amount: 0,
      total_amount: 5,
      direct_units_quantity: 1,
      indirect_units_quantity: 0,
      units_quantity: 1,
    };

    for (const corpo of [{ paging: { total: 1 }, results: [dia] }, { metrics: [dia] }]) {
      const c = cliente([{ status: 200, corpo }]);

      await expect(fetchProductAdsCampaignDailyMetrics(c, "tok", "MLB", 1, "2026-09-15", "2026-09-15")).resolves.toHaveLength(1);
    }
  });

  it("formato desconhecido falha dizendo as chaves que vieram", async () => {
    const c = cliente([{ status: 200, corpo: { id: 1, name: "x", daily: {} } }]);

    await expect(fetchProductAdsCampaignDailyMetrics(c, "tok", "MLB", 1, "2026-09-15", "2026-09-15")).rejects.toThrow(
      "chaves [daily, id, name]",
    );
  });

  it("recusa dia sem custo em vez de gravar zero", async () => {
    const c = cliente([{ status: 200, corpo: [{ date: "2026-09-15", clicks: 1 }] }]);

    await expect(fetchProductAdsCampaignDailyMetrics(c, "tok", "MLB", 1, "2026-09-15", "2026-09-15")).rejects.toThrow();
  });
});
