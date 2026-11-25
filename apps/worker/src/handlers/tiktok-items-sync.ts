import { tiktokItemsSyncPayloadSchema } from "@sb/contracts";
import {
  projectTikTokProductCatalog,
  type ProjectedTikTokListingUnit,
  type TikTokSkuInventoryOverride,
} from "@sb/domain";
import {
  INVENTORY_SEARCH_MAX_PRODUCTS,
  PRODUCT_SEARCH_MAX_PAGE_SIZE,
  searchInventory,
  searchProductsPage,
  type TikTokProductSummary,
} from "@sb/tiktok-shop";

import { chunk } from "../chunk.js";
import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { falhaDoTikTok, lerLojaTikTokConectada, type TikTokJobDeps } from "./tiktok-comum.js";
import type { TikTokSyncRepository } from "./tiktok-repository.js";
import { ensureTikTokAccessToken } from "./tiktok-token.js";

/**
 * Handler `tiktok.items.sync` (D-834, `M04`): varre o catálogo paginado do
 * TikTok Shop, consulta estoque em lotes de até 100 produtos via
 * `searchInventory`, projeta cada variação via `projectTikTokProductCatalog`
 * (preservando ausência como `null`) e persiste de forma idempotente.
 */

const MAX_PAGINAS_CATALOGO = 200;

export interface TikTokItemsSyncDeps extends Pick<TikTokJobDeps, "db" | "client" | "encryptionKey" | "now"> {
  repository: Pick<TikTokSyncRepository, "upsertCatalogUnits">;
}

export function createTikTokItemsSyncHandler(deps: TikTokItemsSyncDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = tiktokItemsSyncPayloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload inválido para tiktok.items.sync" };
    }

    const aberta = await lerLojaTikTokConectada(deps, context, "tiktok_items_sync_skipped", envelope.organizationId);

    if ("outcome" in aberta) return aberta.outcome;

    const { loja } = aberta;
    const now = deps.now?.() ?? new Date();
    const token = await ensureTikTokAccessToken(deps, loja.id, now);

    if (!token.ok) {
      return { status: "failed", retryable: token.retryable, reason: token.reason };
    }

    const shop = { accessToken: token.accessToken, shopCipher: token.shopCipher };

    try {
      const products: TikTokProductSummary[] = [];
      let pageToken: string | undefined;
      let exhausted = false;

      for (let page = 0; page < MAX_PAGINAS_CATALOGO; page += 1) {
        const res = await searchProductsPage(deps.client, shop, {
          pageSize: PRODUCT_SEARCH_MAX_PAGE_SIZE,
          ...(pageToken === undefined ? {} : { pageToken }),
        });

        products.push(...res.products);

        if (res.nextPageToken === null) {
          exhausted = true;
          break;
        }

        pageToken = res.nextPageToken;
      }

      if (!exhausted) {
        return {
          status: "failed",
          retryable: false,
          reason: `catálogo do TikTok Shop excedeu o teto de ${String(MAX_PAGINAS_CATALOGO)} páginas`,
        };
      }

      if (products.length === 0) {
        return { status: "done", processed: 0 };
      }

      const inventoryBySkuId: Record<string, TikTokSkuInventoryOverride> = {};

      for (const batch of chunk(products, INVENTORY_SEARCH_MAX_PRODUCTS)) {
        const invProducts = await searchInventory(deps.client, shop, {
          productIds: batch.map((p) => p.id),
        });

        for (const invProduct of invProducts) {
          for (const sku of invProduct.skus ?? []) {
            inventoryBySkuId[sku.id] = {
              totalAvailableQuantity: sku.total_available_quantity ?? null,
              totalCommittedQuantity: sku.total_committed_quantity ?? null,
            };
          }
        }
      }

      const units: ProjectedTikTokListingUnit[] = [];

      for (const product of products) {
        units.push(
          ...projectTikTokProductCatalog(
            {
              id: product.id,
              title: product.title ?? null,
              status: product.status,
              create_time: product.create_time ?? null,
              update_time: product.update_time ?? null,
              skus: (product.skus ?? []).map((sku) => ({
                id: sku.id,
                seller_sku: sku.seller_sku ?? null,
                price:
                  sku.price === null || sku.price === undefined
                    ? null
                    : {
                        currency: sku.price.currency ?? null,
                        tax_exclusive_price: sku.price.tax_exclusive_price ?? null,
                        sale_price: sku.price.sale_price ?? null,
                      },
                inventory: sku.inventory ?? null,
              })),
            },
            inventoryBySkuId,
          ),
        );
      }

      const saved = await deps.repository.upsertCatalogUnits(loja.organization_id, loja.id, units);

      if (saved.error !== null) {
        return { status: "failed", retryable: true, reason: `falha ao gravar catálogo TikTok: ${saved.error}` };
      }

      return { status: "done", processed: units.length };
    } catch (error) {
      return falhaDoTikTok(error, "erro ao sincronizar catálogo do TikTok Shop");
    }
  };
}
