import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";

import { listingVisitsTimeWindowSchema } from "./listing-visits-schema.js";

/**
 * Sincronização de visitas por anúncio (D-032, docs/ROADMAP.md Fase 5B) — a
 * peça pura de fetch+persist, mesmo split de `ml-listings-fetch.ts`.
 *
 * Enumeração via `sku_listing_links` (`ref_kind='ITEM'`), mesmo mecanismo já
 * usado por Full/listings — mesma limitação, só itens SEM variação.
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

  const links = await params.db
    .from("sku_listing_links")
    .select("item_id")
    .eq("ml_account_id", params.mlAccountId)
    .eq("ref_kind", "ITEM")
    .is("variation_id", null);

  let itemsProcessed = 0;
  let itemsFailed = 0;

  for (const link of links.data ?? []) {
    if (link.item_id === null) {
      // Não deveria acontecer (constraint sku_listing_links_ref_shape) — defesa.
      continue;
    }

    let timeWindow;

    try {
      timeWindow = await params.mercadoLivre.request({
        method: "GET",
        path: `/items/${link.item_id}/visits/time_window`,
        accessToken: params.accessToken,
        searchParams: { last: LAST_DAYS, unit: "day" },
        schema: listingVisitsTimeWindowSchema,
      });
    } catch (error) {
      if (error instanceof MercadoLivreApiError && error.errorClass === "not_retryable") {
        itemsFailed += 1;
        params.logger.warn("listing_visits_fetch_failed", {
          ml_account_id: params.mlAccountId,
          item_id: link.item_id,
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
          item_id: link.item_id,
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
          item_id: link.item_id,
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
