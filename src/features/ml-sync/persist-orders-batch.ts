import "server-only";

import type { MercadoLivreOrder } from "../../integrations/mercado-livre/orders";
import { sweepTargets } from "./current-row-sweep";
import { saoPauloDateKey } from "../../lib/date/sao-paulo";
import type { createAdminClient } from "../../lib/supabase/admin";

/*
 * Extracted from sync-orders-preview.ts (originally steps 1-7 of the
 * per-page persistence loop). Everything here operates on `orders:
 * unknown[]` regardless of how they were fetched — a page from
 * searchSellerOrders, or a single order from getSellerOrder for the
 * orders_v2 refresh path (process-order-refresh-job.ts). The caller
 * decides the metrics rebuild range from `affectedMetricDates`
 * returned here: the bulk sync accumulates per page, the single-order
 * refresh rebuilds only that order's date.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

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

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return value as JsonObject;
}

function getString(object: JsonObject, key: string) {
    const value = object[key];
    return typeof value === "string" ? value : null;
}

function getNumber(object: JsonObject, key: string) {
    const value = object[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getArray(object: JsonObject, key: string) {
    const value = object[key];
    return Array.isArray(value) ? value : [];
}

function getIdString(object: JsonObject, key: string) {
    const value = object[key];
    if (typeof value === "string" || typeof value === "number") {
        return String(value);
    }
    return null;
}

function parseDate(value: string | null) {
    if (!value) {
        return null;
    }
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) {
        return null;
    }
    return new Date(timestamp).toISOString();
}

function normalizeSku(value: string) {
    return value.trim().toUpperCase();
}

function toSaoPauloDateKey(value: string | null) {
    if (!value) {
        return null;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return null;
    }
    return saoPauloDateKey(date);
}

type OrderProductCandidate = {
    sku: string;
    skuKey: string;
    name: string | null;
};

function extractOrderItemSku(line: JsonObject, item: JsonObject) {
    const itemSku = getString(item, "seller_sku");
    if (itemSku?.trim()) {
        return itemSku.trim();
    }

    const lineSku = getString(line, "seller_sku");
    if (lineSku?.trim()) {
        return lineSku.trim();
    }

    const customField = getString(item, "seller_custom_field");
    return customField?.trim() ? customField.trim() : null;
}

function collectOrderProductCandidates(orders: unknown[]) {
    const candidates = new Map<string, OrderProductCandidate>();

    for (const rawOrder of orders) {
        const order = asObject(rawOrder);
        if (!order) {
            continue;
        }

        for (const rawLine of getArray(order, "order_items")) {
            const line = asObject(rawLine);
            if (!line) {
                continue;
            }

            const item = asObject(line.item);
            if (!item) {
                continue;
            }

            const sellerSku = extractOrderItemSku(line, item);
            if (!sellerSku) {
                continue;
            }

            const skuKey = normalizeSku(sellerSku);
            if (!candidates.has(skuKey)) {
                candidates.set(skuKey, {
                    sku: sellerSku,
                    skuKey,
                    name:
                        getString(item, "title") ??
                        getString(line, "title") ??
                        null,
                });
            }
        }
    }

    return candidates;
}

export type PersistOrdersBatchResult = {
    orderIdMap: Map<string, string>;
    importedOrders: number;
    importedItems: number;
    mappedItems: number;
    unmappedItems: number;
    affectedMetricDates: string[];
};

export async function persistOrdersBatch({
    admin,
    organizationId,
    mlAccountId,
    sellerId,
    orders,
    syncRunId,
}: {
    admin: AdminClient;
    organizationId: string;
    mlAccountId: string;
    sellerId: string;
    orders: unknown[];
    syncRunId: string;
}): Promise<PersistOrdersBatchResult> {
    // --------------------------------------------------------
    // Identify every MLB referenced by the orders.
    // --------------------------------------------------------

    const itemIds = new Set<string>();

    for (const rawOrder of orders) {
        const order = rawOrder as MercadoLivreOrder;

        for (const rawLine of getArray(order, "order_items")) {
            const line = asObject(rawLine);
            if (!line) {
                continue;
            }

            const item = asObject(line.item);
            if (!item) {
                continue;
            }

            const itemId = getIdString(item, "id");
            if (itemId) {
                itemIds.add(itemId);
            }
        }
    }

    // --------------------------------------------------------
    // Resolve listings.
    // --------------------------------------------------------

    const listingByItemId = new Map<
        string,
        { id: string; productId: string | null; sellerSku: string | null }
    >();

    if (itemIds.size > 0) {
        const { data: listings, error: listingsError } = (await admin
            .from("ml_listings")
            .select(["id", "item_id", "product_id", "seller_sku"].join(","))
            .eq("ml_account_id", mlAccountId)
            .in("item_id", Array.from(itemIds))) as {
            data: MlListingRow[] | null;
            error: unknown;
        };

        if (listingsError) {
            throw new Error(
                "Não foi possível relacionar os pedidos aos anúncios.",
            );
        }

        for (const listing of listings ?? []) {
            listingByItemId.set(listing.item_id, {
                id: listing.id,
                productId: listing.product_id,
                sellerSku: listing.seller_sku,
            });
        }
    }

    // --------------------------------------------------------
    // Resolve variations.
    // --------------------------------------------------------

    const listingIds = Array.from(listingByItemId.values()).map(
        (listing) => listing.id,
    );

    const variationByKey = new Map<
        string,
        { productId: string | null; sellerSku: string | null }
    >();

    if (listingIds.length > 0) {
        const { data: variations, error: variationsError } = (await admin
            .from("ml_listing_variations")
            .select(
                ["ml_listing_id", "variation_id", "product_id", "seller_sku"].join(
                    ",",
                ),
            )
            .in("ml_listing_id", listingIds)) as {
            data: MlListingVariationRow[] | null;
            error: unknown;
        };

        if (variationsError) {
            throw new Error(
                "Não foi possível relacionar as variações vendidas.",
            );
        }

        for (const variation of variations ?? []) {
            variationByKey.set(
                `${variation.ml_listing_id}:${variation.variation_id}`,
                {
                    productId: variation.product_id,
                    sellerSku: variation.seller_sku,
                },
            );
        }
    }

    // --------------------------------------------------------
    // Create / update canonical products from the real SKUs
    // present in the Mercado Livre order payload.
    // --------------------------------------------------------

    const productCandidates = collectOrderProductCandidates(orders);

    if (productCandidates.size > 0) {
        const productRows = Array.from(productCandidates.values()).map(
            (candidate) => ({
                organization_id: organizationId,
                sku: candidate.sku,
                sku_key: candidate.skuKey,
                name: candidate.name,
            }),
        );

        const { error: productUpsertError } = await admin
            .from("products")
            .upsert(productRows, { onConflict: "organization_id,sku_key" });

        if (productUpsertError) {
            throw new Error(
                "Não foi possível persistir os produtos encontrados nos pedidos.",
            );
        }
    }

    const skuKeys = Array.from(productCandidates.keys());
    const productIdBySku = new Map<string, string>();

    if (skuKeys.length > 0) {
        const { data: products, error: productsError } = await admin
            .from("products")
            .select("id, sku_key")
            .eq("organization_id", organizationId)
            .in("sku_key", skuKeys);

        if (productsError) {
            throw new Error("Não foi possível resolver os SKUs dos pedidos.");
        }

        for (const product of products ?? []) {
            productIdBySku.set(product.sku_key, product.id);
        }
    }

    const now = new Date().toISOString();

    // --------------------------------------------------------
    // Persist orders.
    // --------------------------------------------------------

    const orderRows = orders.flatMap((rawOrder) => {
        const order = asObject(rawOrder) ?? ({} as JsonObject);
        const orderId = getIdString(order, "id");

        if (!orderId) {
            return [];
        }

        const seller = asObject(order.seller);
        const orderSellerId = seller ? getIdString(seller, "id") : null;

        if (orderSellerId && orderSellerId !== sellerId) {
            throw new Error(`O pedido ${orderId} pertence a outro seller.`);
        }

        const shipping = asObject(order.shipping);

        return [
            {
                organization_id: organizationId,
                ml_account_id: mlAccountId,
                external_order_id: orderId,
                pack_id: getIdString(order, "pack_id"),
                status: getString(order, "status"),
                total_amount: getNumber(order, "total_amount"),
                paid_amount: getNumber(order, "paid_amount"),
                currency_id: getString(order, "currency_id"),
                shipping_id: shipping ? getIdString(shipping, "id") : null,
                tags: getArray(order, "tags"),
                date_created: parseDate(getString(order, "date_created")),
                date_closed: parseDate(getString(order, "date_closed")),
                ml_last_updated: parseDate(getString(order, "last_updated")),
                raw_payload: order,
                last_seen_at: now,
                last_seen_sync_run_id: syncRunId,
            },
        ];
    });

    const { data: persistedOrders, error: ordersUpsertError } = await admin
        .from("orders")
        .upsert(orderRows, { onConflict: "ml_account_id,external_order_id" })
        .select("id, external_order_id");

    if (ordersUpsertError) {
        throw new Error("Não foi possível persistir os pedidos.");
    }

    const orderIdMap = new Map<string, string>(
        (persistedOrders ?? []).map((order) => [
            order.external_order_id,
            order.id,
        ]),
    );

    // --------------------------------------------------------
    // Persist order items.
    // --------------------------------------------------------

    const orderItemRows: Record<string, unknown>[] = [];
    let unmappedItems = 0;

    for (const rawOrder of orders) {
        const order = asObject(rawOrder) ?? ({} as JsonObject);
        const externalOrderId = getIdString(order, "id");

        if (!externalOrderId) {
            continue;
        }

        const internalOrderId = orderIdMap.get(externalOrderId);

        if (!internalOrderId) {
            continue;
        }

        for (const rawLine of getArray(order, "order_items")) {
            const line = asObject(rawLine);
            if (!line) {
                continue;
            }

            const item = asObject(line.item);
            if (!item) {
                continue;
            }

            const itemId = getIdString(item, "id");
            if (!itemId) {
                continue;
            }

            const variationId =
                getIdString(item, "variation_id") ??
                getIdString(line, "variation_id");

            const listing = listingByItemId.get(itemId);
            const variation =
                listing && variationId
                    ? variationByKey.get(`${listing.id}:${variationId}`)
                    : null;

            let sellerSku = extractOrderItemSku(line, item);
            sellerSku =
                sellerSku ?? variation?.sellerSku ?? listing?.sellerSku ?? null;

            const productFromSku = sellerSku
                ? productIdBySku.get(normalizeSku(sellerSku)) ?? null
                : null;

            const productId =
                productFromSku ?? variation?.productId ?? listing?.productId ?? null;

            if (!productId) {
                unmappedItems += 1;
            }

            const lineKey = `${itemId}:${variationId ?? "base"}`;

            orderItemRows.push({
                organization_id: organizationId,
                ml_account_id: mlAccountId,
                order_id: internalOrderId,
                ml_listing_id: listing?.id ?? null,
                product_id: productId,
                line_key: lineKey,
                item_id: itemId,
                variation_id: variationId,
                seller_sku: sellerSku,
                title: getString(item, "title"),
                quantity: getNumber(line, "quantity") ?? 1,
                unit_price: getNumber(line, "unit_price"),
                full_unit_price: getNumber(line, "full_unit_price"),
                sale_fee: getNumber(line, "sale_fee"),
                currency_id: getString(line, "currency_id"),
                is_current: true,
                raw_payload: line,
                last_seen_at: now,
                last_seen_sync_run_id: syncRunId,
            });
        }
    }

    if (orderItemRows.length > 0) {
        const { error: itemsUpsertError } = await admin
            .from("order_items")
            .upsert(orderItemRows, { onConflict: "order_id,line_key" });

        if (itemsUpsertError) {
            throw new Error("Não foi possível persistir os itens dos pedidos.");
        }
    }

    /*
     * Linhas que existiam em uma versão anterior do pedido e não
     * vieram mais precisam sair de `is_current`, senão continuam
     * somando unidades e receita rateada de itens que já não
     * compõem o pedido.
     *
     * A varredura usa os pedidos processados, não as linhas
     * recebidas: um pedido que voltou sem nenhum item é exatamente
     * o caso em que a linha antiga precisa ser invalidada.
     *
     * Roda antes do rebuild de métricas, que lê `is_current`.
     */
    const orderItemSweepTargets = sweepTargets(orderIdMap.values());

    if (orderItemSweepTargets.length > 0) {
        const { error: staleOrderItemsError } = await admin
            .from("order_items")
            .update({ is_current: false })
            .in("order_id", orderItemSweepTargets)
            .eq("is_current", true)
            .neq("last_seen_sync_run_id", syncRunId);

        if (staleOrderItemsError) {
            throw new Error(
                `Não foi possível invalidar itens antigos dos pedidos: ${staleOrderItemsError.message}`,
            );
        }
    }

    const affectedMetricDates = orderRows
        .map((order) => toSaoPauloDateKey(order.date_created))
        .filter((value): value is string => Boolean(value))
        .sort();

    return {
        orderIdMap,
        importedOrders: orderRows.length,
        importedItems: orderItemRows.length,
        mappedItems: orderItemRows.length - unmappedItems,
        unmappedItems,
        affectedMetricDates,
    };
}
