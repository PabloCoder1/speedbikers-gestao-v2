import "server-only";

import { MERCADO_LIVRE_URLS } from "@/integrations/mercado-livre/constants";

export type MercadoLivreJsonObject =
    Record<string, unknown>;

type SellerItemsSearchResponse = {
    seller_id?: unknown;
    results?: unknown;
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