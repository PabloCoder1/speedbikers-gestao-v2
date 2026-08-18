import "server-only";

import {
    getValidMercadoLivreAccessToken,
} from "../../integrations/mercado-livre/access-token";

import {
    searchSellerOrders,
} from "../../integrations/mercado-livre/orders";

import { persistOrdersBatch } from "./persist-orders-batch";
import { createAdminClient } from "../../lib/supabase/admin";


type MlAccountRow = {
    id: string;
    organization_id: string;
    display_name: string;
    seller_id: string | null;
    connection_status: string;
};

type ListingsyncStatusRow = {
    status: string;
};

const PREVIEW_LIMIT =
    50;


export type OrdersSyncType =
    | "orders_preview"
    | "orders_recent"
    | "orders_backfill"
    | "orders_dashboard_backfill";


/*
 * Distingue a origem do sync_run: orders_v2 (via
 * process-order-refresh-job.ts) é o caminho principal de frescor;
 * orders_recent virou rede de segurança de reconciliação; backfills
 * são preenchimento de histórico. Aditivo — não muda nenhum
 * comportamento existente.
 */
function syncOriginFor(syncType: OrdersSyncType) {
    if (syncType === "orders_recent") {
        return "poll_reconcile";
    }

    if (
        syncType === "orders_backfill" ||
        syncType === "orders_dashboard_backfill"
    ) {
        return "backfill";
    }

    return null;
}


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

    if (
        account.connection_status !==
        "connected" ||
        !account.seller_id
    ) {
        throw new Error(
            "A conta Mercado Livre não está conectada corretamente.",
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
        error: listingSyncError,
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


    if (listingSyncError) {
        throw new Error(
            "Não foi possível verificar a sincronização completa dos anúncios.",
        );
    }

    if (
        !listingSync ||
        listingSync.status !==
        "succeeded"
    ) {
        throw new Error(
            "Aguarde a sincronização completa dos anúncios desta conta terminar antes de importar pedidos.",
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

                    origin:
                        syncOriginFor(syncType),
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
                        "orders_backfill" ||
                        syncType ===
                        "orders_dashboard_backfill"
                        ? "date_asc"
                        : "date_desc",

                dateCreatedFrom,

                dateCreatedTo,
            });


        const orders =
            search.orders;


        // --------------------------------------------------------
        // Resolve listings/variations, upsert products, orders and
        // order_items, sweep stale order_items — all shared with the
        // single-order orders_v2 refresh path.
        // --------------------------------------------------------

        const persistResult =
            await persistOrdersBatch({
                admin,
                organizationId,
                mlAccountId,
                sellerId: account.seller_id,
                orders,
                syncRunId: syncRun.id,
            });


        /*
         * The metrics rebuild joins orders with order_items,
         * therefore it must run only after both upserts above.
         */
        const affectedMetricDates =
            persistResult.affectedMetricDates;


        if (
            affectedMetricDates.length >
            0
        ) {
            const metricDateFrom =
                affectedMetricDates[0];


            const metricDateTo =
                affectedMetricDates[
                affectedMetricDates.length -
                1
                ];


            const {
                error:
                metricsRebuildError,
            } = await admin.rpc(
                "rebuild_sales_metrics_for_account_range",
                {
                    target_ml_account_id:
                        mlAccountId,

                    target_date_from:
                        metricDateFrom,

                    target_date_to:
                        metricDateTo,
                },
            );


            if (
                metricsRebuildError
            ) {
                throw new Error(
                    "Os pedidos foram persistidos, mas as métricas analíticas não puderam ser atualizadas.",
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
                        persistResult.importedOrders,

                    records_upserted:
                        persistResult.importedOrders,

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
                            persistResult.importedOrders,

                        order_items_imported:
                            persistResult.importedItems,

                        unmapped_order_items:
                            persistResult.unmappedItems,

                        token_refreshed:
                            validToken.refreshed,

                        origin:
                            syncOriginFor(syncType),
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
            syncRunId:
                syncRun.id,

            sellerTotal:
                search.total,

            pageOrders:
                search.orders.length,

            importedOrders:
                persistResult.importedOrders,

            importedItems:
                persistResult.importedItems,

            mappedItems:
                persistResult.mappedItems,

            unmappedItems:
                persistResult.unmappedItems,

            tokenRefreshed:
                validToken.refreshed,
        };
    } catch (error) {
        if (manageRunLifecycle) {
            const { error: failureCheckpointError } = await admin
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

            if (failureCheckpointError) {
                throw new Error(
                    `A importação de pedidos falhou e o estado de falha não foi persistido: ${failureCheckpointError.message}`,
                );
            }
        }


        throw error;
    }
}
