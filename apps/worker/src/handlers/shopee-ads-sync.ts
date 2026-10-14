import {
  ADS_DAILY_MAX_RANGE_DAYS,
  ShopeeApiError,
  fromShopeeAdsDate,
  getAllCpcAdsDailyPerformance,
  type ShopeeAdsDay,
} from "@sb/shopee";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { asJson } from "./domain-events.js";
import { falhaDaShopee, lerLojaConectada, type ShopeeJobDeps } from "./shopee-comum.js";
import { ensureShopeeAccessToken } from "./shopee-token.js";

/**
 * `shopee.ads.sync` (D-449) — o desempenho diário dos anúncios CPC de UMA loja
 * Shopee (`get_all_cpc_ads_daily_performance`).
 *
 * - Sem leitura anterior, lê os últimos 90 dias (São Paulo) em pedaços de até
 *   30 (o máximo da API); depois, relê as duas últimas semanas — o GMV
 *   atribuído muda até 7 dias depois do clique.
 * - A cada leitura, os dias lidos sobrescrevem os guardados e a cobertura da
 *   loja (`ads_read_from`/`ads_read_until`) cresce: dentro dela, dia sem linha
 *   é dia sem anúncio.
 * - No máximo uma leitura a cada 3 horas: é enfileirada por
 *   `shopee.orders.sync` toda hora, e Ads não muda nesse ritmo.
 * - `error_not_found` (loja sem dado de Ads) é período vazio; o limite de
 *   requisições de Ads (`ads.rate_limit.*`) é passageiro.
 */

const PRIMEIRA_LEITURA_DIAS = 90;
const RELEITURA_DIAS = 14;
const INTERVALO_MINIMO_MS = 3 * 3_600_000;
const DIA_MS = 86_400_000;

export type ShopeeAdsSyncDeps = ShopeeJobDeps;

/** O dia de hoje em São Paulo, `AAAA-MM-DD`. */
export function hojeEmSaoPaulo(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
}

function somarDias(iso: string, dias: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + dias * DIA_MS).toISOString().slice(0, 10);
}

/** Pedaços de até 30 dias, cada um com início ANTES do fim (a API recusa o dia sozinho). */
export function pedacos(de: string, ate: string): { startDate: string; endDate: string }[] {
  const lista: { startDate: string; endDate: string }[] = [];

  for (let inicio = de; inicio <= ate; inicio = somarDias(inicio, ADS_DAILY_MAX_RANGE_DAYS)) {
    const fim = somarDias(inicio, ADS_DAILY_MAX_RANGE_DAYS - 1) < ate ? somarDias(inicio, ADS_DAILY_MAX_RANGE_DAYS - 1) : ate;

    // Sobrou um dia só: começa um dia antes (relê um dia já pedido).
    lista.push(inicio === fim ? { startDate: somarDias(fim, -1), endDate: fim } : { startDate: inicio, endDate: fim });
  }

  return lista;
}

export function createShopeeAdsSyncHandler(deps: ShopeeAdsSyncDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const aberta = await lerLojaConectada(deps, context, "shopee_ads_sync_skipped");

    if ("outcome" in aberta) return aberta.outcome;

    const { loja } = aberta;
    const lida = await deps.db.from("shopee_shops").select("ads_read_until, ads_synced_at").eq("id", loja.id).maybeSingle();

    if (lida.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao ler a cobertura de Ads: ${lida.error.message}` };
    }

    const now = deps.now?.() ?? new Date();
    const lidaAte = lida.data?.ads_read_until ?? null;
    const sincronizadaEm = lida.data?.ads_synced_at ?? null;

    if (lidaAte !== null && sincronizadaEm !== null && now.getTime() - new Date(sincronizadaEm).getTime() < INTERVALO_MINIMO_MS) {
      context.logger.info("shopee_ads_sync_skipped", { shopee_shop_id: loja.id, motivo: "lida há menos de 3 horas" });

      return { status: "done", processed: 0 };
    }

    const token = await ensureShopeeAccessToken(deps, { id: loja.id, shopId: loja.shop_id }, now);

    if (!token.ok) {
      return { status: "failed", retryable: token.retryable, reason: token.reason };
    }

    const shop = { accessToken: token.accessToken, shopId: loja.shop_id };
    const hoje = hojeEmSaoPaulo(now);
    const ate = hoje;
    const de =
      lidaAte === null
        ? somarDias(hoje, -(PRIMEIRA_LEITURA_DIAS - 1))
        : somarDias(lidaAte < hoje ? lidaAte : hoje, -(RELEITURA_DIAS - 1));
    const dias: ShopeeAdsDay[] = [];

    for (const pedaco of pedacos(de, ate)) {
      try {
        dias.push(...(await getAllCpcAdsDailyPerformance(deps.client, shop, pedaco)));
      } catch (error) {
        if (error instanceof ShopeeApiError && error.baseCode === "error_not_found") {
          continue;
        }

        if (error instanceof ShopeeApiError && error.code?.startsWith("ads.rate_limit") === true) {
          return { status: "failed", retryable: true, reason: error.message };
        }

        return falhaDaShopee(error, "erro desconhecido ao ler o desempenho de Ads da Shopee");
      }
    }

    const linhas = dias.map((d) => ({
      metric_date: fromShopeeAdsDate(d.date),
      impressions: d.impression ?? null,
      clicks: d.clicks ?? null,
      direct_orders: d.direct_order ?? null,
      broad_orders: d.broad_order ?? null,
      direct_items: d.direct_item_sold ?? null,
      broad_items: d.broad_item_sold ?? null,
      direct_gmv: d.direct_gmv ?? null,
      broad_gmv: d.broad_gmv ?? null,
      expense: d.expense ?? null,
    }));

    const gravado = await deps.db.rpc("shopee_upsert_ads_days", {
      p_shopee_shop_id: loja.id,
      p_dias: asJson(linhas),
      p_read_from: de,
      p_read_until: ate,
      p_synced_at: now.toISOString(),
    });

    if (gravado.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao gravar o desempenho de Ads: ${gravado.error.message}` };
    }

    context.logger.info("shopee_ads_sync_done", {
      shopee_shop_id: loja.id,
      shop_id: loja.shop_id,
      de,
      ate,
      dias_lidos: linhas.length,
      dias_gravados: gravado.data,
    });

    return { status: "done", processed: gravado.data };
  };
}
