import { z } from "zod";

import type { ShopeeClient } from "./client.js";

/**
 * Ads (D-449) — `v2.ads.get_all_cpc_ads_daily_performance`, conferida na
 * referência oficial em 14/10/2026 (e o "Shopee On-Platform Ads API Guide").
 *
 * - Desempenho dos anúncios CPC da LOJA, por dia: impressões, cliques,
 *   pedidos, itens e GMV atribuídos ao anúncio (direto: o item clicado;
 *   amplo: qualquer item da loja até 7 dias depois do clique), gasto
 *   (`expense`) e ROAS.
 * - Datas `DD-MM-YYYY`; período de no máximo 1 mês, até 6 meses atrás, sem
 *   data futura e com início DIFERENTE do fim (um dia sozinho só pela consulta
 *   por hora).
 * - Os anúncios GMV Max de loja têm consulta própria, que devolve só o
 *   agregado do período: a documentação não diz se o gasto deles está aqui.
 * - Permissão: o app Seller In House System pode chamar.
 */

/** O período máximo de uma chamada (documentação), em dias. */
export const ADS_DAILY_MAX_RANGE_DAYS = 30;

const numero = z.number().nullable().optional();
const inteiro = z.number().int().nullable().optional();

export const shopeeAdsDaySchema = z.object({
  // DD-MM-YYYY
  date: z.string().regex(/^\d{2}-\d{2}-\d{4}$/),
  impression: inteiro,
  clicks: inteiro,
  direct_order: inteiro,
  broad_order: inteiro,
  direct_item_sold: inteiro,
  broad_item_sold: inteiro,
  direct_gmv: numero,
  broad_gmv: numero,
  expense: numero,
});

export type ShopeeAdsDay = z.infer<typeof shopeeAdsDaySchema>;

const dailySchema = z.object({
  // Sem anúncio no período a lista pode vir vazia ou faltar.
  response: z.array(shopeeAdsDaySchema).nullable().optional(),
});

/** `AAAA-MM-DD` -> `DD-MM-AAAA`, o formato da API. */
export function toShopeeAdsDate(iso: string): string {
  const [ano, mes, dia] = iso.split("-");

  return `${dia ?? ""}-${mes ?? ""}-${ano ?? ""}`;
}

/** `DD-MM-AAAA` -> `AAAA-MM-DD`. */
export function fromShopeeAdsDate(shopee: string): string {
  const [dia, mes, ano] = shopee.split("-");

  return `${ano ?? ""}-${mes ?? ""}-${dia ?? ""}`;
}

/** O desempenho diário dos anúncios CPC da loja entre duas datas `AAAA-MM-DD` (início < fim). */
export async function getAllCpcAdsDailyPerformance(
  client: ShopeeClient,
  shop: { accessToken: string; shopId: number },
  options: { startDate: string; endDate: string },
): Promise<ShopeeAdsDay[]> {
  if (options.startDate >= options.endDate) {
    throw new Error("get_all_cpc_ads_daily_performance pede início anterior ao fim");
  }

  const resposta = await client.request({
    method: "GET",
    path: "/api/v2/ads/get_all_cpc_ads_daily_performance",
    shop,
    query: { start_date: toShopeeAdsDate(options.startDate), end_date: toShopeeAdsDate(options.endDate) },
    schema: dailySchema,
  });

  return resposta.response ?? [];
}
