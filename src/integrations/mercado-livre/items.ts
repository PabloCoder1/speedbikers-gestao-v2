import "server-only";

import { MERCADO_LIVRE_URLS } from "@/integrations/mercado-livre/constants";

const SALE_PRICE_TIMEOUT_MS =
    15_000;

export type MercadoLivreJsonObject =
    Record<string, unknown>;

export type MercadoLivreSalePriceResponse =
    Record<string, unknown>;

export type MercadoLivreNormalizedSalePrice = {
    priceId: string | null;

    amount: number | null;
    regularAmount: number | null;

    currencyId: string | null;
    referenceDate: string | null;

    campaignId: string | null;
    promotionId: string | null;
    promotionType: string | null;
    isPricePerQuantity: boolean | null;
};

function isSalePriceObject(
    value: unknown,
): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
    );
}


function readSalePriceString(
    value: unknown,
): string | null {
    return typeof value === "string"
        ? value
        : null;
}


function readSalePriceNumber(
    value: unknown,
): number | null {
    if (
        typeof value === "number" &&
        Number.isFinite(value)
    ) {
        return value;
    }

    if (
        typeof value === "string" &&
        value.trim()
    ) {
        const parsed =
            Number(value);

        return Number.isFinite(parsed)
            ? parsed
            : null;
    }

    return null;
}

function readSalePriceBoolean(
    value: unknown,
): boolean | null {
    return typeof value === "boolean"
        ? value
        : null;
}


export function normalizeMercadoLivreSalePrice(
    payload:
        MercadoLivreSalePriceResponse,
): MercadoLivreNormalizedSalePrice {
    const metadata =
        isSalePriceObject(
            payload.metadata,
        )
            ? payload.metadata
            : null;

    return {
        priceId:
            readSalePriceString(
                payload.price_id,
            ),

        amount:
            readSalePriceNumber(
                payload.amount,
            ),

        regularAmount:
            readSalePriceNumber(
                payload.regular_amount,
            ),

        currencyId:
            readSalePriceString(
                payload.currency_id,
            ),

        referenceDate:
            readSalePriceString(
                payload.reference_date,
            ),

        campaignId:
            metadata
                ? readSalePriceString(
                    metadata.campaign_id,
                )
                : null,

        promotionId:
            metadata
                ? readSalePriceString(
                    metadata.promotion_id,
                )
                : null,

        promotionType:
            metadata
                ? readSalePriceString(
                    metadata.promotion_type,
                )
                : null,

        isPricePerQuantity:
            metadata
                ? readSalePriceBoolean(
                    metadata.is_price_per_quantity,
                )
                : null,
    };
}

type SellerItemsSearchResponse = {
    seller_id?: unknown;
    results?: unknown;
    scroll_id?: unknown;

    paging?: {
        total?: unknown;
        offset?: unknown;
        limit?: unknown;
    };
};

export async function searchSellerItemIds({
    sellerId,
    accessToken,
    limit = 20,
    offset = 0,
}: {
    sellerId: string;
    accessToken: string;
    limit?: number;
    offset?: number;
}) {
    const url =
        new URL(
            `${MERCADO_LIVRE_URLS.api}/users/${encodeURIComponent(
                sellerId,
            )}/items/search`,
        );

    url.searchParams.set(
        "offset",
        String(offset),
    );

    url.searchParams.set(
        "limit",
        String(limit),
    );

    const response =
        await fetch(url, {
            headers: {
                Authorization:
                    `Bearer ${accessToken}`,

                Accept:
                    "application/json",
            },

            cache: "no-store",
        });

    if (!response.ok) {
        throw new Error(
            `Falha ao consultar anúncios do seller. HTTP ${response.status}.`,
        );
    }

    const payload =
        (await response.json()) as
        SellerItemsSearchResponse;

    const results =
        Array.isArray(
            payload.results,
        )
            ? payload.results.filter(
                (
                    value,
                ): value is string =>
                    typeof value ===
                    "string" &&
                    value.length > 0,
            )
            : [];

    const total =
        typeof payload.paging
            ?.total === "number"
            ? payload.paging.total
            : results.length;

    return {
        itemIds: results,
        total,
    };
}


export async function scanSellerItemIds({
    sellerId,
    accessToken,
    limit = 50,
    scrollId = null,
}: {
    sellerId: string;
    accessToken: string;
    limit?: number;
    scrollId?: string | null;
}) {
    const url =
        new URL(
            `${MERCADO_LIVRE_URLS.api}/users/${encodeURIComponent(
                sellerId,
            )}/items/search`,
        );

    url.searchParams.set(
        "search_type",
        "scan",
    );

    url.searchParams.set(
        "limit",
        String(limit),
    );

    if (scrollId) {
        url.searchParams.set(
            "scroll_id",
            scrollId,
        );
    }

    const response =
        await fetch(
            url,
            {
                headers: {
                    Authorization:
                        `Bearer ${accessToken}`,

                    Accept:
                        "application/json",
                },

                cache:
                    "no-store",
            },
        );

    if (!response.ok) {
        const body =
            await response.text();

        throw new Error(
            `Falha ao percorrer anúncios do seller via scan. HTTP ${response.status}. ${body.slice(
                0,
                300,
            )}`,
        );
    }

    const payload =
        (await response.json()) as
        SellerItemsSearchResponse;

    const results =
        Array.isArray(
            payload.results,
        )
            ? payload.results.filter(
                (
                    value,
                ): value is string =>
                    typeof value ===
                    "string" &&
                    value.length > 0,
            )
            : [];

    const total =
        typeof payload.paging
            ?.total === "number"
            ? payload.paging.total
            : results.length;

    const nextScrollId =
        typeof payload.scroll_id ===
            "string" &&
        payload.scroll_id.length > 0
            ? payload.scroll_id
            : null;

    return {
        itemIds:
            results,

        total,

        scrollId:
            nextScrollId,
    };
}


export async function getMercadoLivreItem({
    itemId,
    accessToken,
}: {
    itemId: string;
    accessToken: string;
}): Promise<MercadoLivreJsonObject> {
    const response =
        await fetch(
            `${MERCADO_LIVRE_URLS.api}/items/${encodeURIComponent(
                itemId,
            )}`,
            {
                headers: {
                    Authorization:
                        `Bearer ${accessToken}`,

                    Accept:
                        "application/json",
                },

                cache: "no-store",
            },
        );

    if (!response.ok) {
        throw new Error(
            `Falha ao consultar ${itemId}. HTTP ${response.status}.`,
        );
    }

    const payload =
        await response.json();

    if (
        !payload ||
        typeof payload !==
        "object" ||
        Array.isArray(payload)
    ) {
        throw new Error(
            `Resposta inválida para ${itemId}.`,
        );
    }

    return payload as
        MercadoLivreJsonObject;
}


export async function getMercadoLivreItemSalePrice({
    itemId,
    accessToken,
    timeoutMs =
        SALE_PRICE_TIMEOUT_MS,
}: {
    itemId: string;
    accessToken: string;
    timeoutMs?: number;
}): Promise<MercadoLivreSalePriceResponse> {
    const normalizedItemId =
        itemId.trim();

    if (!normalizedItemId) {
        throw new Error(
            "Item Mercado Livre é obrigatório para consultar sale_price.",
        );
    }

    if (!accessToken) {
        throw new Error(
            "Access token Mercado Livre é obrigatório para consultar sale_price.",
        );
    }

    const url =
        new URL(
            `${MERCADO_LIVRE_URLS.api}/items/${encodeURIComponent(
                normalizedItemId,
            )}/sale_price`,
        );

    url.searchParams.set(
        "context",
        "channel_marketplace",
    );

    const controller =
        new AbortController();
    const timeout =
        setTimeout(
            () => {
                controller.abort();
            },
            timeoutMs,
        );

    try {
        const response =
            await fetch(
                url,
                {
                    method: "GET",
                    headers: {
                        Authorization:
                            `Bearer ${accessToken}`,
                        Accept:
                            "application/json",
                    },
                    cache:
                        "no-store",
                    signal:
                        controller.signal,
                },
            );
        if (!response.ok) {
            const body =
                await response.text();
            throw new Error(
                `Falha ao consultar sale_price de ${normalizedItemId}. HTTP ${response.status}. ${body.slice(0, 300)}`,
            );
        }
        const payload: unknown =
            await response.json();
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Error(`Resposta inválida de sale_price para ${normalizedItemId}.`);
        }
        return payload as MercadoLivreSalePriceResponse;
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`REQUEST_TIMEOUT: sale_price de ${normalizedItemId} excedeu ${timeoutMs}ms.`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}


export async function getMercadoLivreItems({
    itemIds,
    accessToken,
}: {
    itemIds: string[];
    accessToken: string;
}) {
    const items:
        MercadoLivreJsonObject[] = [];

    const concurrency = 5;

    for (
        let index = 0;
        index < itemIds.length;
        index += concurrency
    ) {
        const batch =
            itemIds.slice(
                index,
                index + concurrency,
            );

        const results =
            await Promise.all(
                batch.map(
                    (itemId) =>
                        getMercadoLivreItem({
                            itemId,
                            accessToken,
                        }),
                ),
            );

        items.push(...results);
    }

    return items;
}
