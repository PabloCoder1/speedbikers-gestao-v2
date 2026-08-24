import type { AdminClient } from "@sb/db";
import { detectListingEvents } from "@sb/domain";
import type { ListingSnapshot } from "@sb/domain";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";

import { recordDomainEvents } from "./domain-events.js";
import { listingItemSchema } from "./listing-schema.js";

/**
 * Sincronização de listings/anúncios (D-058, docs/ROADMAP.md Fase 5B) — a
 * peça pura de fetch+persist, mesmo split de `ml-fulfillment-fetch.ts`.
 *
 * Enumeração via `sku_listing_links` (`ref_kind='ITEM'`), mesmo mecanismo já
 * usado por Full — não `/users/{id}/items/search`: o alvo desta fatia é
 * "anúncio já vinculado a um SKU", que é o que os itens do checklist da
 * Fase 5B (Dashboard de SKU/Anúncio, Curva ABC) precisam. Um catálogo mais
 * amplo (itens ainda sem vínculo) fica para quando houver evidência de que
 * "descobrir anúncio novo" é o problema real, não presumido.
 *
 * **Escopo desta etapa, deliberadamente limitado a itens SEM variação**
 * (mesmo raciocínio, mesma limitação de `ml-fulfillment-fetch.ts`): a doc
 * oficial não mostra o formato exato de variação dentro da resposta de
 * `/items` para codar esse ramo sem adivinhar.
 *
 * **Motor de diff (D-072, pré-requisito crítico da Fase 7,
 * `docs/HANDOFF.md`):** a linha ANTERIOR de `listings` é lida antes do
 * upsert sobrescrevê-la — `listings` é projeção MUTÁVEL, não ledger
 * (`docs/DATABASE.md`), então o "antes" só existe até este momento.
 * `detectListingEvents` (`@sb/domain`) compara e emite `domain_events` para
 * preço, título, status (só `paused`/`reactivated`, catalogadas desde a
 * Fase 0) e quantidade disponível — best-effort via `recordDomainEvents`,
 * nunca derruba a sincronização se a gravação do evento falhar.
 */

export interface FetchListingsParams {
  db: AdminClient;
  organizationId: string;
  mlAccountId: string;
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
  logger: Logger;
  now?: () => Date;
}

export interface FetchListingsResult {
  itemsProcessed: number;
  /** Erro NÃO retryable do Mercado Livre (ex.: 404 — anúncio removido) — mesmo tratamento de Full. */
  itemsFailed: number;
}

export async function fetchListings(params: FetchListingsParams): Promise<FetchListingsResult> {
  const syncedAt = params.now?.() ?? new Date();

  const links = await params.db
    .from("sku_listing_links")
    .select("item_id, sku_id")
    .eq("ml_account_id", params.mlAccountId)
    .eq("ref_kind", "ITEM")
    .is("variation_id", null);

  if (links.error !== null) {
    // Não tratar como "conta sem anúncio vinculado nenhum": o chamador
    // (sync-listings-snapshot.ts) já tem try/catch em volta desta função e
    // registra falha de verdade — sem isto, uma falha de leitura virava
    // "done, 0 processados", indistinguível de sincronização bem-sucedida.
    throw new Error(`falha ao ler sku_listing_links: ${links.error.message}`);
  }

  let itemsProcessed = 0;
  let itemsFailed = 0;

  for (const link of links.data) {
    if (link.item_id === null) {
      // Não deveria acontecer (constraint sku_listing_links_ref_shape) — defesa.
      continue;
    }

    let item;

    try {
      item = await params.mercadoLivre.request({
        method: "GET",
        path: `/items/${link.item_id}`,
        accessToken: params.accessToken,
        schema: listingItemSchema,
      });
    } catch (error) {
      if (error instanceof MercadoLivreApiError && error.errorClass === "not_retryable") {
        itemsFailed += 1;
        params.logger.warn("listing_item_fetch_failed", {
          ml_account_id: params.mlAccountId,
          item_id: link.item_id,
          reason: error.message,
        });

        continue;
      }

      throw error;
    }

    const previousRow = await params.db
      .from("listings")
      .select("title, status, price, available_quantity")
      .eq("ml_account_id", params.mlAccountId)
      .eq("item_id", item.id)
      .maybeSingle();

    const previous: ListingSnapshot | null =
      previousRow.data === null
        ? null
        : {
            itemId: item.id,
            title: previousRow.data.title,
            status: previousRow.data.status,
            price: previousRow.data.price,
            availableQuantity: previousRow.data.available_quantity,
          };

    const result = await params.db
      .from("listings")
      .upsert(
        {
          organization_id: params.organizationId,
          ml_account_id: params.mlAccountId,
          item_id: item.id,
          sku_id: link.sku_id,
          title: item.title,
          status: item.status,
          price: item.price,
          currency_id: item.currency_id,
          available_quantity: item.available_quantity,
          category_id: item.category_id ?? null,
          synced_at: syncedAt.toISOString(),
        },
        { onConflict: "ml_account_id,item_id" },
      );

    if (result.error !== null) {
      params.logger.error("listing_not_recorded", {
        ml_account_id: params.mlAccountId,
        item_id: link.item_id,
        reason: result.error.message,
      });

      continue;
    }

    const current: ListingSnapshot = {
      itemId: item.id,
      title: item.title,
      status: item.status,
      price: item.price,
      availableQuantity: item.available_quantity,
    };

    const events = detectListingEvents(previous, current, syncedAt);

    if (events.length > 0) {
      await recordDomainEvents(
        params.db,
        { organizationId: params.organizationId, mlAccountId: params.mlAccountId },
        events,
        params.logger,
      );
    }

    itemsProcessed += 1;
  }

  return { itemsProcessed, itemsFailed };
}
