import "server-only";

import { MERCADO_LIVRE_URLS } from "@/integrations/mercado-livre/constants";

export type MercadoLivreOrderSort =
    | "date_desc"
    | "date_asc";

export type MercadoLivreOrder = Record<string, unknown>;


type OrdersSearchResponse = {
    results?: unknown;

    paging?: {
        total?: unknown;
        offset?: unknown;
        limit?: unknown;
    };
};


export async function searchSellerOrders({
    sellerId,
    accessToken,
    limit = 50,
    offset = 0,
    sort = "date_desc",
}: {
    sellerId: string;
    accessToken: string;
    limit?: number;
    offset?: number;
    sort?: MercadoLivreOrderSort;
}) {
    const url =
        new URL(
            `${MERCADO_LIVRE_URLS.api}/orders/search`,
        );


    url.searchParams.set(
        "seller",
        sellerId,
    );

    url.searchParams.set(
        "sort",
        sort,
    );

    url.searchParams.set(
        "limit",
        String(limit),
    );

    url.searchParams.set(
        "offset",
        String(offset),
    );


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
        throw new Error(
            `Falha ao consultar pedidos do seller. HTTP ${response.status}.`,
        );
    }


    const payload =
        (await response.json()) as
        OrdersSearchResponse;


    const results =
        Array.isArray(
            payload.results,
        )
            ? payload.results.filter(
                (
                    value,
                ): value is MercadoLivreOrder =>
                    Boolean(
                        value &&
                        typeof value ===
                        "object" &&
                        !Array.isArray(
                            value,
                        ),
                    ),
            )
            : [];


    const total =
        typeof payload.paging
            ?.total === "number"
            ? payload.paging.total
            : results.length;


    return {
        orders:
            results,

        total,
    };
}