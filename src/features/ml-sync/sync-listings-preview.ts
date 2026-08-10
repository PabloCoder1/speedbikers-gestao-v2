import "server-only";

import {
  getValidMercadoLivreAccessToken,
} from "@/integrations/mercado-livre/access-token";
import {
  getMercadoLivreItems,
  searchSellerItemIds,
  type MercadoLivreJsonObject,
} from "@/integrations/mercado-livre/items";
import { createAdminClient } from "@/lib/supabase/admin";

const PREVIEW_LIMIT = 20;

function asObject(
  value: unknown,
): MercadoLivreJsonObject | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }

  return value as
    MercadoLivreJsonObject;
}

function getString(
  object: MercadoLivreJsonObject,
  key: string,
) {
  const value =
    object[key];

  return typeof value ===
    "string"
    ? value
    : null;
}

function getNumber(
  object: MercadoLivreJsonObject,
  key: string,
) {
  const value =
    object[key];

  return typeof value ===
    "number" &&
    Number.isFinite(value)
    ? value
    : null;
}

function getBoolean(
  object: MercadoLivreJsonObject,
  key: string,
) {
  const value =
    object[key];

  return typeof value ===
    "boolean"
    ? value
    : null;
}

function getArray(
  object: MercadoLivreJsonObject,
  key: string,
) {
  const value =
    object[key];

  return Array.isArray(value)
    ? value
    : [];
}

function getAttributeString(
  object: MercadoLivreJsonObject,
  attributeId: string,
) {
  const attributes =
    getArray(
      object,
      "attributes",
    );

  for (
    const rawAttribute
    of attributes
  ) {
    const attribute =
      asObject(rawAttribute);

    if (!attribute) {
      continue;
    }

    if (
      getString(
        attribute,
        "id",
      ) !== attributeId
    ) {
      continue;
    }

    const valueName =
      getString(
        attribute,
        "value_name",
      );

    if (
      valueName?.trim()
    ) {
      return valueName.trim();
    }

    const values =
      getArray(
        attribute,
        "values",
      );

    const firstValue =
      asObject(values[0]);

    if (firstValue) {
      const name =
        getString(
          firstValue,
          "name",
        );

      if (name?.trim()) {
        return name.trim();
      }
    }
  }

  return null;
}

function extractSellerSku(
  object: MercadoLivreJsonObject,
) {
  // Newer/structured form.
  const attributeSku =
    getAttributeString(
      object,
      "SELLER_SKU",
    );

  if (attributeSku) {
    return attributeSku;
  }

  // Compatibility with older item/variation payloads.
  const customField =
    getString(
      object,
      "seller_custom_field",
    );

  return customField?.trim()
    ? customField.trim()
    : null;
}

function normalizeSku(
  sku: string,
) {
  return sku
    .trim()
    .toUpperCase();
}

function parseDateString(
  value: string | null,
) {
  if (!value) {
    return null;
  }

  const timestamp =
    Date.parse(value);

  return Number.isNaN(
    timestamp,
  )
    ? null
    : new Date(
        timestamp,
      ).toISOString();
}

type ProductCandidate = {
  sku: string;
  skuKey: string;
  name: string | null;
};

type MercadoLivreAccountRow = {
  id: string;
  organization_id: string;
  code: string;
  display_name: string | null;
  seller_id: string | null;
  connection_status: string;
};

function collectProductCandidates(
  items:
    MercadoLivreJsonObject[],
) {
  const products =
    new Map<
      string,
      ProductCandidate
    >();

  for (const item of items) {
    const title =
      getString(
        item,
        "title",
      );

    const listingSku =
      extractSellerSku(item);

    if (listingSku) {
      const skuKey =
        normalizeSku(
          listingSku,
        );

      products.set(
        skuKey,
        {
          sku: listingSku,
          skuKey,
          name: title,
        },
      );
    }

    for (
      const rawVariation
      of getArray(
        item,
        "variations",
      )
    ) {
      const variation =
        asObject(
          rawVariation,
        );

      if (!variation) {
        continue;
      }

      const variationSku =
        extractSellerSku(
          variation,
        );

      if (!variationSku) {
        continue;
      }

      const skuKey =
        normalizeSku(
          variationSku,
        );

      products.set(
        skuKey,
        {
          sku:
            variationSku,
          skuKey,
          name: title,
        },
      );
    }
  }

  return products;
}


export async function syncListingsPreview({
  organizationId,
  mlAccountId,
}: {
  organizationId: string;
  mlAccountId: string;
}) {
  const admin =
    createAdminClient();

  const {
    data: account,
    error: accountError,
  } = await admin
    .from("ml_accounts")
    .select(
      [
        "id",
        "organization_id",
        "code",
        "display_name",
        "seller_id",
        "connection_status",
      ].join(","),
    )
    .eq(
      "id",
      mlAccountId,
    )
    .eq(
      "organization_id",
      organizationId,
    )
    .maybeSingle<MercadoLivreAccountRow>();

  if (
    accountError ||
    !account
  ) {
    throw new Error(
      "Conta Mercado Livre não encontrada.",
    );
  }

  const typedAccount =
    account as MercadoLivreAccountRow;

  // Deliberately restricted while SB is our pilot.
  if (typedAccount.code !== "sb") {
    throw new Error(
      "Nesta fase a sincronização real está liberada apenas para a conta SB.",
    );
  }

  if (
    typedAccount.connection_status !==
      "connected" ||
    !typedAccount.seller_id
  ) {
    throw new Error(
      "A conta SB não está conectada corretamente.",
    );
  }

  const {
    data: syncRun,
    error: syncRunError,
  } = await admin
    .from("sync_runs")
    .insert({
      organization_id:
        organizationId,

      ml_account_id:
        mlAccountId,

      sync_type:
        "listings_preview",

      status:
        "running",

      metadata: {
        mode:
          "preview",
        limit:
          PREVIEW_LIMIT,
      },
    })
    .select("id")
    .single();

  if (
    syncRunError ||
    !syncRun
  ) {
    throw new Error(
      "Não foi possível criar o registro da sincronização.",
    );
  }

  try {
    const validToken =
      await getValidMercadoLivreAccessToken(
        mlAccountId,
      );

    const search =
      await searchSellerItemIds({
        sellerId:
          typedAccount.seller_id,

        accessToken:
          validToken.accessToken,

        limit:
          PREVIEW_LIMIT,
      });

    const items =
      await getMercadoLivreItems({
        itemIds:
          search.itemIds,

        accessToken:
          validToken.accessToken,
      });

    const productCandidates =
      collectProductCandidates(
        items,
      );

    if (
      productCandidates.size >
      0
    ) {
      const productRows =
        Array.from(
          productCandidates.values(),
        ).map(
          (product) => ({
            organization_id:
              organizationId,

            sku:
              product.sku,

            sku_key:
              product.skuKey,

            name:
              product.name,
          }),
        );

      const {
        error:
          productsUpsertError,
      } = await admin
        .from("products")
        .upsert(
          productRows,
          {
            onConflict:
              "organization_id,sku_key",
          },
        );

      if (
        productsUpsertError
      ) {
        throw new Error(
          "Não foi possível persistir os SKUs encontrados.",
        );
      }
    }

    const skuKeys =
      Array.from(
        productCandidates.keys(),
      );

    const productIdBySku =
      new Map<
        string,
        string
      >();

    if (
      skuKeys.length > 0
    ) {
      const {
        data: products,
        error:
          productsReadError,
      } = await admin
        .from("products")
        .select(
          "id, sku_key",
        )
        .eq(
          "organization_id",
          organizationId,
        )
        .in(
          "sku_key",
          skuKeys,
        );

      if (
        productsReadError
      ) {
        throw new Error(
          "Não foi possível resolver os produtos por SKU.",
        );
      }

      for (
        const product
        of products ?? []
      ) {
        productIdBySku.set(
          product.sku_key,
          product.id,
        );
      }
    }

    const now =
      new Date()
        .toISOString();

    const listingRows =
      items.flatMap(
        (item) => {
          const itemId =
            getString(
              item,
              "id",
            );

          if (!itemId) {
            return [];
          }

          const sellerSku =
            extractSellerSku(
              item,
            );

          const productId =
            sellerSku
              ? productIdBySku.get(
                  normalizeSku(
                    sellerSku,
                  ),
                ) ?? null
              : null;

          return [
            {
              organization_id:
                organizationId,

              ml_account_id:
                mlAccountId,

              product_id:
                productId,

              item_id:
                itemId,

              user_product_id:
                getString(
                  item,
                  "user_product_id",
                ),

              title:
                getString(
                  item,
                  "title",
                ),

              seller_sku:
                sellerSku,

              category_id:
                getString(
                  item,
                  "category_id",
                ),

              domain_id:
                getString(
                  item,
                  "domain_id",
                ),

              catalog_product_id:
                getString(
                  item,
                  "catalog_product_id",
                ),

              listing_type_id:
                getString(
                  item,
                  "listing_type_id",
                ),

              status:
                getString(
                  item,
                  "status",
                ),

              sub_status:
                getArray(
                  item,
                  "sub_status",
                ),

              price:
                getNumber(
                  item,
                  "price",
                ),

              currency_id:
                getString(
                  item,
                  "currency_id",
                ),

              initial_quantity:
                getNumber(
                  item,
                  "initial_quantity",
                ),

              available_quantity:
                getNumber(
                  item,
                  "available_quantity",
                ),

              sold_quantity:
                getNumber(
                  item,
                  "sold_quantity",
                ),

              health:
                getNumber(
                  item,
                  "health",
                ),

              catalog_listing:
                getBoolean(
                  item,
                  "catalog_listing",
                ),

              permalink:
                getString(
                  item,
                  "permalink",
                ),

              thumbnail:
                getString(
                  item,
                  "thumbnail",
                ),

              date_created:
                parseDateString(
                  getString(
                    item,
                    "date_created",
                  ),
                ),

              ml_last_updated:
                parseDateString(
                  getString(
                    item,
                    "last_updated",
                  ),
                ),

              raw_payload:
                item,

              is_current:
                true,

              last_seen_at:
                now,

              last_seen_sync_run_id:
                syncRun.id,
            },
          ];
        },
      );

    const {
      data:
        persistedListings,
      error:
        listingUpsertError,
    } = await admin
      .from("ml_listings")
      .upsert(
        listingRows,
        {
          onConflict:
            "ml_account_id,item_id",
        },
      )
      .select(
        "id, item_id",
      );

    if (
      listingUpsertError
    ) {
      throw new Error(
        "Não foi possível persistir os anúncios.",
      );
    }

    const listingIdByItem =
      new Map<
        string,
        string
      >(
        (
          persistedListings ??
          []
        ).map(
          (listing) => [
            listing.item_id,
            listing.id,
          ],
        ),
      );

    const variationRows:
      Record<
        string,
        unknown
      >[] = [];

    for (const item of items) {
      const itemId =
        getString(
          item,
          "id",
        );

      if (!itemId) {
        continue;
      }

      const listingId =
        listingIdByItem.get(
          itemId,
        );

      if (!listingId) {
        continue;
      }

      for (
        const rawVariation
        of getArray(
          item,
          "variations",
        )
      ) {
        const variation =
          asObject(
            rawVariation,
          );

        if (!variation) {
          continue;
        }

        const rawVariationId =
          variation.id;

        if (
          typeof rawVariationId !==
            "string" &&
          typeof rawVariationId !==
            "number"
        ) {
          continue;
        }

        const variationId =
          String(
            rawVariationId,
          );

        const sellerSku =
          extractSellerSku(
            variation,
          );

        const productId =
          sellerSku
            ? productIdBySku.get(
                normalizeSku(
                  sellerSku,
                ),
              ) ?? null
            : null;

        variationRows.push({
          organization_id:
            organizationId,

          ml_account_id:
            mlAccountId,

          ml_listing_id:
            listingId,

          product_id:
            productId,

          variation_id:
            variationId,

          seller_sku:
            sellerSku,

          price:
            getNumber(
              variation,
              "price",
            ),

          available_quantity:
            getNumber(
              variation,
              "available_quantity",
            ),

          sold_quantity:
            getNumber(
              variation,
              "sold_quantity",
            ),

          attribute_combinations:
            getArray(
              variation,
              "attribute_combinations",
            ),

          raw_payload:
            variation,

          is_current:
            true,

          last_seen_at:
            now,

          last_seen_sync_run_id:
            syncRun.id,
        });
      }
    }

    if (
      variationRows.length >
      0
    ) {
      const {
        error:
          variationUpsertError,
      } = await admin
        .from(
          "ml_listing_variations",
        )
        .upsert(
          variationRows,
          {
            onConflict:
              "ml_listing_id,variation_id",
          },
        );

      if (
        variationUpsertError
      ) {
        throw new Error(
          "Não foi possível persistir as variações.",
        );
      }

      const listingIds =
        Array.from(
          listingIdByItem.values(),
        );

      if (
        listingIds.length > 0
      ) {
        await admin
          .from(
            "ml_listing_variations",
          )
          .update({
            is_current:
              false,
          })
          .in(
            "ml_listing_id",
            listingIds,
          )
          .neq(
            "last_seen_sync_run_id",
            syncRun.id,
          );
      }
    }

    const {
      error:
        finishRunError,
    } = await admin
      .from("sync_runs")
      .update({
        status:
          "succeeded",

        records_discovered:
          search.total,

        records_processed:
          items.length,

        records_upserted:
          listingRows.length,

        metadata: {
          mode:
            "preview",

          limit:
            PREVIEW_LIMIT,

          seller_total:
            search.total,

          products_found:
            productCandidates.size,

          variations_found:
            variationRows.length,

          token_refreshed:
            validToken.refreshed,
        },

        finished_at:
          new Date()
            .toISOString(),
      })
      .eq(
        "id",
        syncRun.id,
      );

    if (
      finishRunError
    ) {
      throw new Error(
        "Os anúncios foram importados, mas não foi possível finalizar o histórico de sincronização.",
      );
    }

    await admin
      .from("ml_accounts")
      .update({
        last_synced_at:
          new Date()
            .toISOString(),
      })
      .eq(
        "id",
        mlAccountId,
      );

    return {
      sellerTotal:
        search.total,

      importedListings:
        listingRows.length,

      productsFound:
        productCandidates.size,

      variationsFound:
        variationRows.length,

      tokenRefreshed:
        validToken.refreshed,
    };
  } catch (error) {
    await admin
      .from("sync_runs")
      .update({
        status:
          "failed",

        error_code:
          "listings_preview_failed",

        error_message:
          error instanceof Error
            ? error.message
            : "Erro desconhecido.",

        finished_at:
          new Date()
            .toISOString(),
      })
      .eq(
        "id",
        syncRun.id,
      );

    throw error;
  }
}