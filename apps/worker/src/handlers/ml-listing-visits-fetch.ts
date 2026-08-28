import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";

import { listingVisitsTimeWindowSchema } from "./listing-visits-schema.js";

/**
 * Sincronização de visitas por anúncio (D-032, docs/ROADMAP.md Fase 5B) — a
 * peça pura de fetch+persist, mesmo split de `ml-listings-fetch.ts`.
 *
 * **Enumeração pelo CATÁLOGO (`listings`), status ATIVO** — não mais por
 * `sku_listing_links` (D-124). A enumeração por vínculo tinha duas falhas ao
 * mesmo tempo: deixava de fora anúncio com variação e anúncio sem vínculo
 * (1.539 ativos, medido), e gastava chamada em item que nem está ativo
 * (1.866, medido). Trocar melhora cobertura E baixa a carga: 3.252 chamadas
 * contra 3.579.
 *
 * `daily_listing_visits` não exige SKU (grão é conta+item), então anúncio sem
 * vínculo é sincronizável — diferente de Full, cujo `sku_id` é NOT NULL.
 *
 * Só ATIVOS de propósito: a API de visitas aceita **1 item por chamada**
 * (`docs/MERCADO_LIVRE.md` secao 2.15), então cada item custa uma requisição
 * por dia. Anúncio pausado ou encerrado não recebe tráfego relevante, e as
 * linhas históricas dele continuam onde estão.
 *
 * `last=3`: pega os últimos 3 dias a cada rodada (a de ontem, que já
 * fechou, mais hoje e anteontem de reforço) — a cadência do job é DIÁRIA
 * (`sync-listing-visits-snapshot.ts`), então uma folga de um dia extra
 * absorve uma rodada perdida sem esperar até o próximo dia.
 */

const LAST_DAYS = 3;

export interface FetchListingVisitsParams {
  db: AdminClient;
  organizationId: string;
  mlAccountId: string;
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
  logger: Logger;
  now?: () => Date;
}

export interface FetchListingVisitsResult {
  itemsProcessed: number;
  /** Erro NÃO retryable do Mercado Livre (ex.: 404 — anúncio removido) — mesmo tratamento de Full/listings. */
  itemsFailed: number;
}

export async function fetchListingVisits(
  params: FetchListingVisitsParams,
): Promise<FetchListingVisitsResult> {
  const syncedAt = params.now?.() ?? new Date();

  const listings = await params.db
    .from("listings")
    .select("item_id")
    .eq("ml_account_id", params.mlAccountId)
    .eq("status", "active");

  if (listings.error !== null) {
    // Mesmo raciocínio de ml-listings-fetch.ts: o chamador
    // (sync-listing-visits-snapshot.ts) já tem try/catch em volta e registra
    // falha de verdade — sem isto, virava "done, 0 processados".
    throw new Error(`falha ao ler listings: ${listings.error.message}`);
  }

  let itemsProcessed = 0;
  let itemsFailed = 0;

  for (const listing of listings.data) {

    let timeWindow;

    try {
      timeWindow = await params.mercadoLivre.request({
        method: "GET",
        path: `/items/${listing.item_id}/visits/time_window`,
        accessToken: params.accessToken,
        searchParams: { last: LAST_DAYS, unit: "day" },
        schema: listingVisitsTimeWindowSchema,
      });
    } catch (error) {
      if (error instanceof MercadoLivreApiError && error.errorClass === "not_retryable") {
        itemsFailed += 1;
        params.logger.warn("listing_visits_fetch_failed", {
          ml_account_id: params.mlAccountId,
          item_id: listing.item_id,
          reason: error.message,
        });

        continue;
      }

      throw error;
    }

    let recorded = true;

    for (const entry of timeWindow.results) {
      const result = await params.db.from("daily_listing_visits").upsert(
        {
          organization_id: params.organizationId,
          ml_account_id: params.mlAccountId,
          item_id: listing.item_id,
          // Data de negócio, sem hora — mesmo raciocínio de `formatBusinessDate`:
          // manipulação de string, nunca `new Date(...)`, para não deslocar o
          // dia por fuso (a API devolve `"2021-08-04T00:00:00Z"`).
          metric_date: entry.date.slice(0, 10),
          visits: entry.total,
          synced_at: syncedAt.toISOString(),
        },
        { onConflict: "ml_account_id,item_id,metric_date" },
      );

      if (result.error !== null) {
        params.logger.error("listing_visits_not_recorded", {
          ml_account_id: params.mlAccountId,
          item_id: listing.item_id,
          metric_date: entry.date.slice(0, 10),
          reason: result.error.message,
        });

        recorded = false;
      }
    }

    if (recorded) {
      itemsProcessed += 1;
    }
  }

  return { itemsProcessed, itemsFailed };
}
