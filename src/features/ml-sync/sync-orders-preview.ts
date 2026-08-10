import "server-only";

import {
    getValidMercadoLivreAccessToken,
} from "../../integrations/mercado-livre/access-token";

import {
    searchSellerOrders,
    type MercadoLivreOrder,
} from "../../integrations/mercado-livre/orders";

import { createAdminClient } from "../../lib/supabase/admin";


type MlAccountRow = {
    id: string;
    organization_id: string;
    code: string;
    display_name: string;
    seller_id: string | null;
    connection_status: string;
};

type ListingsyncStatusRow = {
    status: string;
};

type MlListingRow = {
    id: string;
    item_id: string;
    product_id: string | null;
    seller_sku: string | null;
};

type MlListingVariationRow = {
    ml_listing_id: string;
    variation_id: string;
    product_id: string | null;
    seller_sku: string | null;
};

const PREVIEW_LIMIT =
    50;


type JsonObject =
    Record<string, unknown>;


function asObject(
    value: unknown,
): JsonObject | null {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value)
    ) {
        return null;
    }

    return value as JsonObject;
}


function getString(
    object: JsonObject,
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
    object: JsonObject,
    key: string,
) {
    const value =
        object[key];

    return (
        typeof value ===
        "number" &&
        Number.isFinite(value)
    )
        ? value
        : null;
}


function getArray(
    object: JsonObject,
    key: string,
) {
    const value =
        object[key];

    return Array.isArray(value)
        ? value
        : [];
}


function getIdString(
    object: JsonObject,
    key: string,
) {
    const value =
        object[key];

    if (
        typeof value ===
        "string" ||
        typeof value ===
        "number"
    ) {
        return String(value);
    }

    return null;
}


function parseDate(
    value: string | null,
) {
    if (!value) {
        return null;
    }

    const timestamp =
        Date.parse(value);

    if (
        Number.isNaN(
            timestamp,
        )
    ) {
        return null;
    }

    return new Date(
        timestamp,
    ).toISOString();
}


function normalizeSku(
    value: string,
) {
    return value
        .trim()
        .toUpperCase();
}

type OrderProductCandidate = {
    sku: string;
    skuKey: string;
    name: string | null;
};

function collectOrderProductCandidates(
    orders: unknown[],
) {
    const candidates =
        new Map<
            string,
            OrderProductCandidate
        >();

    for (
        const rawOrder
        of orders
    ) {
        const order =
            asObject(rawOrder);

        if (!order) {
            continue;
        }

        for (
            const rawLine
            of getArray(
                order,
                "order_items",
            )
        ) {
            const line =
                asObject(rawLine);

            if (!line) {
                continue;
            }

            const item =
                asObject(
                    line.item,
                );

            if (!item) {
                continue;
            }

            const sellerSku =
                extractOrderItemSku(
                    line,
                    item,
                );

            if (!sellerSku) {
                continue;
            }

            const skuKey =
                normalizeSku(
                    sellerSku,
                );

            if (!candidates.has(
                skuKey,
            )) {
                candidates.set(
                    skuKey,
                    {
                        sku:
                            sellerSku,

                        skuKey,

                        name:
                            getString(
                                item,
                                "title",
                            ) ??
                            getString(
                                line,
                                "title",
                            ) ??
                            null,
                    },
                );
            }
        }
    }

    return candidates;
}


function extractOrderItemSku(
    line: JsonObject,
    item: JsonObject,
) {
    const itemSku =
        getString(
            item,
            "seller_sku",
        );

    if (itemSku?.trim()) {
        return itemSku.trim();
    }


    const lineSku =
        getString(
            line,
            "seller_sku",
        );

    if (lineSku?.trim()) {
        return lineSku.trim();
    }


    const customField =
        getString(
            item,
            "seller_custom_field",
        );

    return customField?.trim()
        ? customField.trim()
        : null;
}


export type OrdersSyncType =
  | "orders_preview"
  | "orders_recent"
  | "orders_backfill";


export async function syncOrdersPreview({
  organizationId,
  mlAccountId,
  syncType = "orders_preview",
  limit = PREVIEW_LIMIT,
  offset = 0,
  dateCreatedFrom = null,
  dateCreatedTo = null,
  existingSyncRunId = null,
  manageRunLifecycle = true,
}: {
  organizationId: string;
  mlAccountId: string;
  syncType?: OrdersSyncType;
  limit?: number;
  offset?: number;
  dateCreatedFrom?: string | null;
  dateCreatedTo?: string | null;
  existingSyncRunId?: string | null;
  manageRunLifecycle?: boolean;
}) {
    const admin =
        createAdminClient();


    const {
        data: account,
        error: accountError,
    } = (await admin
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
        .maybeSingle()) as {
            data: MlAccountRow | null;
            error: unknown;
        };


    if (
        accountError ||
        !account
    ) {
        throw new Error(
            "Conta Mercado Livre não encontrada.",
        );
    }


    if (account.code !== "sb") {
        throw new Error(
            "Nesta fase a importação de pedidos está liberada somente para a SB.",
        );
    }


    if (
        account.connection_status !==
        "connected" ||
        !account.seller_id
    ) {
        throw new Error(
            "A conta SB não está conectada corretamente.",
        );
    }


    /*
     * Para termos o melhor vínculo possível
     * pedido → anúncio → SKU → produto,
     * exigimos uma sincronização completa
     * de anúncios concluída.
     */
    const {
        data: listingSync,
    } = (await admin
        .from("sync_runs")
        .select(
            "status",
        )
        .eq(
            "ml_account_id",
            mlAccountId,
        )
        .eq(
            "sync_type",
            "listings_full",
        )
        .order(
            "started_at",
            {
                ascending: false,
            },
        )
        .limit(1)
        .maybeSingle()) as {
            data: ListingsyncStatusRow | null;
            error: unknown;
        };


    if (
        !listingSync ||
        listingSync.status !==
        "succeeded"
    ) {
        throw new Error(
            "Aguarde a sincronização completa dos anúncios da SB terminar antes de importar pedidos.",
        );
    }


    let syncRun: {
        id: string;
    };

    if (existingSyncRunId) {
        syncRun = {
            id:
                existingSyncRunId,
        };
    } else {
        const {
            data,
            error,
        } = await admin
            .from("sync_runs")
            .insert({
                organization_id:
                    organizationId,

                ml_account_id:
                    mlAccountId,

                sync_type:
                    syncType,

                status:
                    "running",

                batch_size:
                    limit,

                metadata: {
                    mode:
                        syncType ===
                        "orders_backfill"
                            ? "backfill"
                            : syncType ===
                                "orders_recent"
                              ? "incremental"
                              : "preview",

                    limit,

                    offset,

                    date_created_from:
                        dateCreatedFrom,

                    date_created_to:
                        dateCreatedTo,
                },
            })
            .select("id")
            .single();

        if (
            error ||
            !data
        ) {
            throw new Error(
                "Não foi possível registrar a sincronização dos pedidos.",
            );
        }

        syncRun = data;
    }


    try {
        const validToken =
            await getValidMercadoLivreAccessToken(
                mlAccountId,
            );


        const search =
            await searchSellerOrders({
                sellerId:
                    account.seller_id,

                accessToken:
                    validToken.accessToken,

                limit,

                offset,

                sort:
                    syncType ===
                    "orders_backfill"
                        ? "date_asc"
                        : "date_desc",

                dateCreatedFrom,

                dateCreatedTo,
            });


        const orders =
            search.orders;


        // --------------------------------------------------------
        // Identify every MLB referenced by the orders.
        // --------------------------------------------------------

        const itemIds =
            new Set<string>();


        for (
            const rawOrder
            of orders
        ) {
            const order =
                rawOrder as
                MercadoLivreOrder;


            for (
                const rawLine
                of getArray(
                    order,
                    "order_items",
                )
            ) {
                const line =
                    asObject(rawLine);

                if (!line) {
                    continue;
                }


                const item =
                    asObject(
                        line.item,
                    );

                if (!item) {
                    continue;
                }


                const itemId =
                    getIdString(
                        item,
                        "id",
                    );

                if (itemId) {
                    itemIds.add(
                        itemId,
                    );
                }
            }
        }


        // --------------------------------------------------------
        // Resolve listings.
        // --------------------------------------------------------

        const listingByItemId =
            new Map<
                string,
                {
                    id: string;
                    productId: string | null;
                    sellerSku: string | null;
                }
            >();


        if (
            itemIds.size > 0
        ) {
            const {
                data: listings,
                error: listingsError,
            } = (await admin
                .from("ml_listings")
                .select(
                    [
                        "id",
                        "item_id",
                        "product_id",
                        "seller_sku",
                    ].join(","),
                )
                .eq(
                    "ml_account_id",
                    mlAccountId,
                )
                .in(
                    "item_id",
                    Array.from(
                        itemIds,
                    ),
                )) as {
                    data: MlListingRow[] | null;
                    error: unknown;
                };


            if (listingsError) {
                throw new Error(
                    "Não foi possível relacionar os pedidos aos anúncios.",
                );
            }


            for (
                const listing
                of listings ?? []
            ) {
                listingByItemId.set(
                    listing.item_id,
                    {
                        id:
                            listing.id,

                        productId:
                            listing.product_id,

                        sellerSku:
                            listing.seller_sku,
                    },
                );
            }
        }


        // --------------------------------------------------------
        // Resolve variations.
        // --------------------------------------------------------

        const listingIds =
            Array.from(
                listingByItemId.values(),
            ).map(
                (listing) =>
                    listing.id,
            );


        const variationByKey =
            new Map<
                string,
                {
                    productId: string | null;
                    sellerSku: string | null;
                }
            >();


        if (
            listingIds.length > 0
        ) {
            const {
                data: variations,
                error:
                variationsError,
            } = (await admin
                .from(
                    "ml_listing_variations",
                )
                .select(
                    [
                        "ml_listing_id",
                        "variation_id",
                        "product_id",
                        "seller_sku",
                    ].join(","),
                )
                .in(
                    "ml_listing_id",
                    listingIds,
                )) as {
                    data: MlListingVariationRow[] | null;
                    error: unknown;
                };


            if (
                variationsError
            ) {
                throw new Error(
                    "Não foi possível relacionar as variações vendidas.",
                );
            }


            for (
                const variation
                of variations ?? []
            ) {
                variationByKey.set(
                    `${variation.ml_listing_id}:${variation.variation_id}`,
                    {
                        productId:
                            variation.product_id,

                        sellerSku:
                            variation.seller_sku,
                    },
                );
            }
        }


        // --------------------------------------------------------
        // Create / update canonical products from the real SKUs
        // present in the Mercado Livre order payload.
        // --------------------------------------------------------

        const productCandidates =
            collectOrderProductCandidates(
                orders,
            );

        if (
            productCandidates.size >
            0
        ) {
            const productRows =
                Array.from(
                    productCandidates.values(),
                ).map(
                    (candidate) => ({
                        organization_id:
                            organizationId,

                        sku:
                            candidate.sku,

                        sku_key:
                            candidate.skuKey,

                        name:
                            candidate.name,
                    }),
                );

            const {
                error:
                productUpsertError,
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
                productUpsertError
            ) {
                throw new Error(
                    "Não foi possível persistir os produtos encontrados nos pedidos.",
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
                error: productsError,
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
                productsError
            ) {
                throw new Error(
                    "Não foi possível resolver os SKUs dos pedidos.",
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


        // --------------------------------------------------------
        // Persist orders.
        // --------------------------------------------------------

        const orderRows =
            orders.flatMap(
                (rawOrder) => {
                    const orderId =
                        getIdString(
                            rawOrder,
                            "id",
                        );


                    if (!orderId) {
                        return [];
                    }


                    const seller =
                        asObject(
                            rawOrder.seller,
                        );


                    const sellerId =
                        seller
                            ? getIdString(
                                seller,
                                "id",
                            )
                            : null;


                    if (
                        sellerId &&
                        sellerId !==
                        account.seller_id
                    ) {
                        throw new Error(
                            `O pedido ${orderId} pertence a outro seller.`,
                        );
                    }


                    const shipping =
                        asObject(
                            rawOrder.shipping,
                        );


                    return [
                        {
                            organization_id:
                                organizationId,

                            ml_account_id:
                                mlAccountId,

                            external_order_id:
                                orderId,

                            pack_id:
                                getIdString(
                                    rawOrder,
                                    "pack_id",
                                ),

                            status:
                                getString(
                                    rawOrder,
                                    "status",
                                ),

                            total_amount:
                                getNumber(
                                    rawOrder,
                                    "total_amount",
                                ),

                            paid_amount:
                                getNumber(
                                    rawOrder,
                                    "paid_amount",
                                ),

                            currency_id:
                                getString(
                                    rawOrder,
                                    "currency_id",
                                ),

                            shipping_id:
                                shipping
                                    ? getIdString(
                                        shipping,
                                        "id",
                                    )
                                    : null,

                            tags:
                                getArray(
                                    rawOrder,
                                    "tags",
                                ),

                            date_created:
                                parseDate(
                                    getString(
                                        rawOrder,
                                        "date_created",
                                    ),
                                ),

                            date_closed:
                                parseDate(
                                    getString(
                                        rawOrder,
                                        "date_closed",
                                    ),
                                ),

                            ml_last_updated:
                                parseDate(
                                    getString(
                                        rawOrder,
                                        "last_updated",
                                    ),
                                ),

                            raw_payload:
                                rawOrder,

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
            persistedOrders,
            error:
            ordersUpsertError,
        } = await admin
            .from("orders")
            .upsert(
                orderRows,
                {
                    onConflict:
                        "ml_account_id,external_order_id",
                },
            )
            .select(
                "id, external_order_id",
            );


        if (
            ordersUpsertError
        ) {
            throw new Error(
                "Não foi possível persistir os pedidos.",
            );
        }


        const orderIdMap =
            new Map<
                string,
                string
            >(
                (
                    persistedOrders ??
                    []
                ).map(
                    (order) => [
                        order.external_order_id,
                        order.id,
                    ],
                ),
            );


        // --------------------------------------------------------
        // Persist order items.
        // --------------------------------------------------------

        const orderItemRows:
            Record<
                string,
                unknown
            >[] = [];


        let unmappedItems =
            0;


        for (
            const rawOrder
            of orders
        ) {
            const externalOrderId =
                getIdString(
                    rawOrder,
                    "id",
                );


            if (
                !externalOrderId
            ) {
                continue;
            }


            const internalOrderId =
                orderIdMap.get(
                    externalOrderId,
                );


            if (
                !internalOrderId
            ) {
                continue;
            }


            for (
                const rawLine
                of getArray(
                    rawOrder,
                    "order_items",
                )
            ) {
                const line =
                    asObject(rawLine);

                if (!line) {
                    continue;
                }


                const item =
                    asObject(
                        line.item,
                    );

                if (!item) {
                    continue;
                }


                const itemId =
                    getIdString(
                        item,
                        "id",
                    );


                if (!itemId) {
                    continue;
                }


                const variationId =
                    getIdString(
                        item,
                        "variation_id",
                    ) ??
                    getIdString(
                        line,
                        "variation_id",
                    );


                const listing =
                    listingByItemId.get(
                        itemId,
                    );


                const variation =
                    listing &&
                        variationId
                        ? variationByKey.get(
                            `${listing.id}:${variationId}`,
                        )
                        : null;


                let sellerSku =
                    extractOrderItemSku(
                        line,
                        item,
                    );


                sellerSku =
                    sellerSku ??
                    variation
                        ?.sellerSku ??
                    listing
                        ?.sellerSku ??
                    null;


                const productFromSku =
                    sellerSku
                        ? productIdBySku.get(
                            normalizeSku(
                                sellerSku,
                            ),
                        ) ?? null
                        : null;

                const productId =
                    productFromSku ??
                    variation
                        ?.productId ??
                    listing
                        ?.productId ??
                    null;


                if (!productId) {
                    unmappedItems += 1;
                }


                const lineKey =
                    `${itemId}:${variationId ?? "base"}`;


                orderItemRows.push({
                    organization_id:
                        organizationId,

                    ml_account_id:
                        mlAccountId,

                    order_id:
                        internalOrderId,

                    ml_listing_id:
                        listing?.id ??
                        null,

                    product_id:
                        productId,

                    line_key:
                        lineKey,

                    item_id:
                        itemId,

                    variation_id:
                        variationId,

                    seller_sku:
                        sellerSku,

                    title:
                        getString(
                            item,
                            "title",
                        ),

                    quantity:
                        getNumber(
                            line,
                            "quantity",
                        ) ?? 1,

                    unit_price:
                        getNumber(
                            line,
                            "unit_price",
                        ),

                    full_unit_price:
                        getNumber(
                            line,
                            "full_unit_price",
                        ),

                    sale_fee:
                        getNumber(
                            line,
                            "sale_fee",
                        ),

                    currency_id:
                        getString(
                            line,
                            "currency_id",
                        ),

                    is_current:
                        true,

                    raw_payload:
                        line,

                    last_seen_at:
                        now,

                    last_seen_sync_run_id:
                        syncRun.id,
                });
            }
        }


        if (
            orderItemRows.length >
            0
        ) {
            const {
                error:
                itemsUpsertError,
            } = await admin
                .from("order_items")
                .upsert(
                    orderItemRows,
                    {
                        onConflict:
                            "order_id,line_key",
                    },
                );


            if (
                itemsUpsertError
            ) {
                throw new Error(
                    "Não foi possível persistir os itens dos pedidos.",
                );
            }
        }


        // --------------------------------------------------------
        // Finish sync run.
        // --------------------------------------------------------

        if (manageRunLifecycle) {
            const {
                error:
                finishError,
            } = await admin
                .from("sync_runs")
                .update({
                    status:
                        "succeeded",

                    records_discovered:
                        search.total,

                    records_processed:
                        orderRows.length,

                    records_upserted:
                        orderRows.length,

                    metadata: {
                        mode:
                            syncType ===
                            "orders_recent"
                                ? "incremental"
                                : "preview",

                        limit,

                        offset,

                        date_created_from:
                            dateCreatedFrom,

                        date_created_to:
                            dateCreatedTo,

                        seller_total:
                            search.total,

                        orders_imported:
                            orderRows.length,

                        order_items_imported:
                            orderItemRows.length,

                        unmapped_order_items:
                            unmappedItems,

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


            if (finishError) {
                throw new Error(
                    "Os pedidos foram importados, mas o histórico da sincronização não pôde ser finalizado.",
                );
            }
        }


        return {
            sellerTotal:
                search.total,

            pageOrders:
                search.orders.length,

            importedOrders:
                orderRows.length,

            importedItems:
                orderItemRows.length,

            mappedItems:
                orderItemRows.length -
                unmappedItems,

            unmappedItems,

            tokenRefreshed:
                validToken.refreshed,
        };
    } catch (error) {
        if (manageRunLifecycle) {
            await admin
                .from("sync_runs")
                .update({
                    status:
                        "failed",

                    error_code:
                        "orders_sync_failed",

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
        }


        throw error;
    }
}