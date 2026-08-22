import type { AdminClient } from "@sb/db";
import { detectFulfillmentEvents } from "@sb/domain";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";
import { z } from "zod";

import { recordDomainEvents } from "./domain-events.js";

/**
 * Captura do estoque Full por conta — a peça pura de fetch+persist,
 * compartilhada pelo handler de job (`sync-fulfillment-snapshot.ts`), mesmo
 * split de `ml-orders-fetch.ts`/`sync-orders-window.ts`.
 *
 * `docs/MERCADO_LIVRE.md` secao 2.7: `inventory_id` vem de `GET
 * /items/{item_id}` (campo raiz); o estoque em si vem de `GET
 * /inventories/{inventory_id}/stock/fulfillment`. Dois campos confirmados
 * contra a documentação oficial, lida ao vivo em 2026-08-22.
 *
 * **Escopo desta etapa, deliberadamente limitado**: só itens SEM variação
 * (`sku_listing_links.variation_id IS NULL`). Itens COM variação têm um
 * `inventory_id` por variação, mas a doc oficial não mostra o exemplo exato
 * de onde esse campo aparece dentro de `variations[]` — codar esse ramo sem
 * ver a resposta real violaria a REGRA ABSOLUTA de `docs/MERCADO_LIVRE.md`.
 * Fica para quando isso for confirmado (ex.: contra um XML/JSON real de
 * item com variação).
 *
 * **Sem paginação ainda**: a leitura de `sku_listing_links` usa o limite
 * implícito do PostgREST (1000 linhas). As quatro contas reais têm hoje bem
 * menos que isso na categoria "sem variação" (D-020/secao 2.1), mas uma
 * conta que cresça além disso silenciosamente processaria só as primeiras
 * 1000 — ver se vira problema real antes de adicionar `.range()`.
 */

const itemResponseSchema = z.object({
  id: z.string(),
  /** `null` quando o item nunca foi enviado ao Full — não é erro. */
  inventory_id: z.string().nullable(),
});

const fulfillmentStockResponseSchema = z.object({
  inventory_id: z.string(),
  /** O número acionável (o que pode vender) — não `total`, que inclui avariado/perdido/em trânsito interno. */
  available_quantity: z.number(),
});

export interface FetchFulfillmentSnapshotsParams {
  db: AdminClient;
  organizationId: string;
  mlAccountId: string;
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
  logger: Logger;
  now?: () => Date;
}

export interface FetchFulfillmentSnapshotsResult {
  itemsProcessed: number;
  /** Item sem `inventory_id` (nunca foi ao Full) — contado, não é falha. */
  itemsSkipped: number;
}

export async function fetchFulfillmentSnapshots(
  params: FetchFulfillmentSnapshotsParams,
): Promise<FetchFulfillmentSnapshotsResult> {
  const capturedAt = params.now?.() ?? new Date();

  const links = await params.db
    .from("sku_listing_links")
    .select("item_id, sku_id")
    .eq("ml_account_id", params.mlAccountId)
    .eq("ref_kind", "ITEM")
    .is("variation_id", null);

  let itemsProcessed = 0;
  let itemsSkipped = 0;

  for (const link of links.data ?? []) {
    if (link.item_id === null) {
      // Não deveria acontecer (ref_kind='ITEM' garante item_id no banco,
      // constraint sku_listing_links_ref_shape) — defesa, não caminho normal.
      continue;
    }

    const item = await params.mercadoLivre.request({
      method: "GET",
      path: `/items/${link.item_id}`,
      accessToken: params.accessToken,
      schema: itemResponseSchema,
    });

    if (item.inventory_id === null) {
      itemsSkipped += 1;
      continue;
    }

    const stock = await params.mercadoLivre.request({
      method: "GET",
      path: `/inventories/${item.inventory_id}/stock/fulfillment`,
      accessToken: params.accessToken,
      schema: fulfillmentStockResponseSchema,
    });

    const previousRow = await params.db
      .from("fulfillment_stock_snapshots")
      .select("quantity, captured_at")
      .eq("ml_account_id", params.mlAccountId)
      .eq("inventory_id", stock.inventory_id)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const previous =
      previousRow.data === null
        ? null
        : {
            inventoryId: stock.inventory_id,
            skuId: link.sku_id,
            quantity: previousRow.data.quantity,
            capturedAt: new Date(previousRow.data.captured_at),
          };

    const current = {
      inventoryId: stock.inventory_id,
      skuId: link.sku_id,
      quantity: stock.available_quantity,
      capturedAt,
    };

    await params.db.from("fulfillment_stock_snapshots").insert({
      organization_id: params.organizationId,
      ml_account_id: params.mlAccountId,
      inventory_id: stock.inventory_id,
      item_id: link.item_id,
      variation_id: null,
      sku_id: link.sku_id,
      quantity: stock.available_quantity,
      captured_at: capturedAt.toISOString(),
    });

    const events = detectFulfillmentEvents(previous, current);

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

  return { itemsProcessed, itemsSkipped };
}
