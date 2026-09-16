import { z } from "zod";

import { MercadoLivreApiError } from "./errors.js";
import type { MercadoLivreClient } from "./http-client.js";

/**
 * Mercado Ads — Product Ads, só LEITURA (D-363).
 *
 * Contrato lido na documentação oficial em 16/09/2026 ("Product Ads para
 * Catálogo e User Products", developers.mercadolivre.com.br, atualizada em
 * 06/07/2026 — o portal bloqueia leitura automática; lido num navegador):
 *
 * - **anunciante:** `GET /advertising/advertisers?product_id=PADS` com
 *   `Api-Version: 1`. 404 "No permissions found for user_id" = a conta não tem
 *   Product Ads habilitado (Meu perfil > Publicidade) — é um ESTADO, não erro;
 * - **campanhas:** `GET /advertising/{site}/advertisers/{id}/product_ads/campaigns/search`
 *   com `api-version: 2`, paginado por `limit`/`offset` (padrão 50);
 * - **métricas diárias de UMA campanha:**
 *   `GET /advertising/{site}/product_ads/campaigns/{id}?date_from&date_to&metrics&aggregation_type=DAILY`
 *   devolve uma lista de dias. A doc avisa: só 90 dias para trás, e os números
 *   são atualizados às 10h (GMT-3) — a janela recente é regravada a cada sync.
 *
 * **Os endpoints legados foram desligados em 27/05/2026** (`/advertising/product_ads/...`,
 * `/ads/search`, métricas por anúncio): nenhum deles é usado aqui.
 *
 * O "search com aggregation_type=DAILY" NÃO é usado: o exemplo da doc devolve
 * dias sem o `id` da campanha, e somar o que não se sabe de quem é seria
 * inventar a atribuição. O detalhe por campanha diz de quem é cada dia.
 */

export const PRODUCT_ADS_METRICS = [
  "clicks",
  "prints",
  "cost",
  "direct_amount",
  "indirect_amount",
  "total_amount",
  "direct_units_quantity",
  "indirect_units_quantity",
  "units_quantity",
  "organic_units_quantity",
  "organic_units_amount",
] as const;

/** O máximo que a doc permite pedir para trás. */
export const PRODUCT_ADS_MAX_DAYS_BACK = 90;

const numero = z.number();

const advertisersSchema = z.object({
  advertisers: z.array(
    z.object({
      advertiser_id: z.number().int(),
      site_id: z.string(),
      advertiser_name: z.string().nullish(),
      account_name: z.string().nullish(),
    }),
  ),
});

export const productAdsCampaignSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: z.string(),
  strategy: z.string().nullish(),
  budget: numero.nullish(),
  roas_target: numero.nullish(),
  acos_target: numero.nullish(),
  date_created: z.string().nullish(),
  last_updated: z.string().nullish(),
});

const campaignsPageSchema = z.object({
  paging: z.object({ total: z.number().int(), offset: z.number().int(), limit: z.number().int() }),
  results: z.array(productAdsCampaignSchema),
});

export const productAdsDailyMetricSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  clicks: numero,
  prints: numero,
  cost: numero,
  direct_amount: numero,
  indirect_amount: numero,
  total_amount: numero,
  direct_units_quantity: numero,
  indirect_units_quantity: numero,
  units_quantity: numero,
  organic_units_quantity: numero.nullish(),
  organic_units_amount: numero.nullish(),
});

/**
 * A RESPOSTA REAL NÃO É A DO EXEMPLO (medido em produção, 16/09/2026). A doc
 * mostra o detalhe diário da campanha como uma LISTA de dias; a primeira rodada
 * em produção recebeu um OBJETO ("expected array, received object"). As rotas
 * vizinhas da mesma doc embrulham a lista em `results` (search), então aceita a
 * lista crua, `results` ou `metrics`, e recusa o resto dizendo as CHAVES que
 * vieram, para a próxima rodada mostrar o formato em vez de adivinhar.
 */
export class ProductAdsFormatoInesperado extends Error {
  readonly chaves: readonly string[];

  constructor(chaves: readonly string[]) {
    super(`formato inesperado nas métricas diárias de Product Ads: chaves [${chaves.join(", ")}]`);
    this.name = "ProductAdsFormatoInesperado";
    this.chaves = chaves;
  }
}

function listaDeDias(resposta: unknown): unknown[] {
  if (Array.isArray(resposta)) return resposta;

  if (typeof resposta === "object" && resposta !== null) {
    const objeto = resposta as Record<string, unknown>;

    for (const chave of ["results", "metrics"]) {
      const valor = objeto[chave];

      if (Array.isArray(valor)) return valor;
    }

    throw new ProductAdsFormatoInesperado(Object.keys(objeto).sort());
  }

  throw new ProductAdsFormatoInesperado([typeof resposta]);
}

export type ProductAdsCampaign = z.infer<typeof productAdsCampaignSchema>;
export type ProductAdsDailyMetric = z.infer<typeof productAdsDailyMetricSchema>;

export type ProductAdsAdvertiser =
  | { readonly status: "habilitado"; readonly advertiserId: number; readonly siteId: string }
  | { readonly status: "nao_habilitado" };

/**
 * O anunciante de Product Ads da conta no site informado (MLB). Uma conta sem
 * o produto habilitado é resposta, não falha.
 */
export async function fetchProductAdsAdvertiser(
  client: MercadoLivreClient,
  accessToken: string,
  siteId = "MLB",
): Promise<ProductAdsAdvertiser> {
  try {
    const resposta = await client.request({
      method: "GET",
      path: "/advertising/advertisers",
      accessToken,
      searchParams: { product_id: "PADS" },
      headers: { "Api-Version": "1" },
      schema: advertisersSchema,
    });
    const doSite = resposta.advertisers.find((a) => a.site_id === siteId);

    return doSite === undefined
      ? { status: "nao_habilitado" }
      : { status: "habilitado", advertiserId: doSite.advertiser_id, siteId: doSite.site_id };
  } catch (error) {
    if (error instanceof MercadoLivreApiError && error.status === 404) {
      return { status: "nao_habilitado" };
    }

    throw error;
  }
}

/** Todas as campanhas do anunciante, página a página. */
export async function fetchProductAdsCampaigns(
  client: MercadoLivreClient,
  accessToken: string,
  siteId: string,
  advertiserId: number,
): Promise<ProductAdsCampaign[]> {
  const LIMIT = 50;
  const campanhas: ProductAdsCampaign[] = [];

  for (let offset = 0; ; offset += LIMIT) {
    const pagina = await client.request({
      method: "GET",
      path: `/advertising/${siteId}/advertisers/${String(advertiserId)}/product_ads/campaigns/search`,
      accessToken,
      searchParams: { limit: LIMIT, offset },
      headers: { "api-version": "2" },
      schema: campaignsPageSchema,
    });

    campanhas.push(...pagina.results);

    // A guarda de `results.length` evita laço infinito se o `total` vier maior
    // do que o que a API de fato entrega.
    if (pagina.results.length === 0 || campanhas.length >= pagina.paging.total) {
      return campanhas;
    }
  }
}

/** Métricas por dia de UMA campanha, no intervalo fechado `dateFrom..dateTo`. */
export async function fetchProductAdsCampaignDailyMetrics(
  client: MercadoLivreClient,
  accessToken: string,
  siteId: string,
  campaignId: number,
  dateFrom: string,
  dateTo: string,
): Promise<ProductAdsDailyMetric[]> {
  const resposta = await client.request({
    method: "GET",
    path: `/advertising/${siteId}/product_ads/campaigns/${String(campaignId)}`,
    accessToken,
    searchParams: {
      date_from: dateFrom,
      date_to: dateTo,
      metrics: PRODUCT_ADS_METRICS.join(","),
      aggregation_type: "DAILY",
    },
    headers: { "api-version": "2" },
    schema: z.unknown(),
  });

  return z.array(productAdsDailyMetricSchema).parse(listaDeDias(resposta));
}
