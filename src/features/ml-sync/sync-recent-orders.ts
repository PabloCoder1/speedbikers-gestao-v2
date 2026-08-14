import "server-only";

import { syncOrdersPreview } from "@/features/ml-sync/sync-orders-preview";
import { createAdminClient } from "@/lib/supabase/admin";

type RecentOrdersAccountRow = {
  id: string;
  organization_id: string;
  code: string;
  connection_status: string;
};

type RecentOrdersSyncRunRow = {
  id: string;
  status: string;
  started_at: string;
  error_code: string | null;
};

type ListingsSyncRunRow = {
  status: string;
};

type DueAccount = {
  account: RecentOrdersAccountRow;

  lastStartedAt:
  | number
  | null;
};

const MINIMUM_INTERVAL_MS =
  4 * 60 * 1000;

/*
 * Se o Mercado Livre responder HTTP 429,
 * esperamos mais tempo antes de tentar
 * sincronizar essa conta novamente.
 */
const RATE_LIMIT_COOLDOWN_MS =
  15 * 60 * 1000;

const STALE_RUN_THRESHOLD_MS =
  10 * 60 * 1000;

/*
 * orders_recent deve ser leve e rápido.
 *
 * Reconciliação de pedidos antigos será
 * tratada separadamente.
 */
const RECENT_ORDERS_WINDOW_MS =
  24 * 60 * 60 * 1000;

const PAGE_SIZE =
  50;

/*
 * 12 páginas × 50 pedidos =
 * capacidade máxima de 600 pedidos
 * dentro da janela recente.
 */
const MAX_PAGES_PER_RUN =
  12;

/*
 * Processamos no máximo UMA conta por execução.
 *
 * Isso evita multiplicar chamadas à API do Mercado Livre
 * quando tivermos SpeedBikers, SB, GMR e OffRacer
 * conectadas simultaneamente.
 *
 * A conta há mais tempo sem sincronização tem prioridade.
 */
export async function syncRecentOrdersIfDue() {
  const admin =
    createAdminClient();

  const {
    data: accounts,
    error: accountsError,
  } = (await admin
    .from("ml_accounts")
    .select(
      [
        "id",
        "organization_id",
        "code",
        "connection_status",
      ].join(","),
    )
    .eq(
      "connection_status",
      "connected",
    )
    .eq(
      "is_active",
      true,
    )
    .order(
      "code",
      {
        ascending: true,
      },
    )) as {
      data:
      | RecentOrdersAccountRow[]
      | null;

      error: unknown;
    };

  if (accountsError) {
    throw new Error(
      "Não foi possível carregar as contas Mercado Livre conectadas.",
    );
  }

  if (
    !accounts ||
    accounts.length === 0
  ) {
    return {
      processed: false,

      reason:
        "no_connected_accounts",
    } as const;
  }

  const dueAccounts:
    DueAccount[] = [];

  for (
    const account
    of accounts
  ) {
    /*
     * Pedidos só devem entrar depois que
     * a sincronização completa dos anúncios
     * desta mesma conta tiver sido concluída.
     */
    const {
      data: listingsSync,
      error: listingsSyncError,
    } = (await admin
      .from("sync_runs")
      .select(
        "status",
      )
      .eq(
        "ml_account_id",
        account.id,
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
        data:
        | ListingsSyncRunRow
        | null;

        error: unknown;
      };

    if (listingsSyncError) {
      throw new Error(
        `Não foi possível verificar a sincronização de anúncios da conta ${account.code}.`,
      );
    }

    /*
     * Conta recém-conectada ainda sem anúncios
     * completos não entra no sync incremental.
     */
    if (
      !listingsSync ||
      listingsSync.status !==
      "succeeded"
    ) {
      continue;
    }

    const {
      data: lastSync,
      error: lastSyncError,
    } = (await admin
      .from("sync_runs")
      .select(
        [
          "id",
          "status",
          "started_at",
          "error_code",
        ].join(","),
      )
      .eq(
        "ml_account_id",
        account.id,
      )
      .eq(
        "sync_type",
        "orders_recent",
      )
      .order(
        "started_at",
        {
          ascending: false,
        },
      )
      .limit(1)
      .maybeSingle()) as {
        data:
        | RecentOrdersSyncRunRow
        | null;

        error: unknown;
      };

    if (lastSyncError) {
      throw new Error(
        `Não foi possível verificar a última sincronização de pedidos da conta ${account.code}.`,
      );
    }

    /*
     * Se já existe execução atual para esta
     * conta, não criamos outra concorrente —
     * a menos que ela esteja abandonada.
     */
    if (
      lastSync?.status ===
      "running"
    ) {
      const runningStartedAt =
        Date.parse(
          lastSync.started_at,
        );

      const isStale =
        Number.isNaN(
          runningStartedAt,
        ) ||
        Date.now() -
        runningStartedAt >
        STALE_RUN_THRESHOLD_MS;

      if (!isStale) {
        continue;
      }

      const {
        error: resetError,
      } = await admin
        .from("sync_runs")
        .update({
          status:
            "failed",

          error_code:
            "stale_run_auto_reset",

          error_message:
            "Execução travada em 'running' foi resetada automaticamente.",

          finished_at:
            new Date()
              .toISOString(),
        })
        .eq(
          "id",
          lastSync.id,
        )
        .eq(
          "status",
          "running",
        );

      if (resetError) {
        continue;
      }
    }

    if (!lastSync) {
      dueAccounts.push({
        account,

        lastStartedAt:
          null,
      });

      continue;
    }

    const startedAt =
      Date.parse(
        lastSync.started_at,
      );

    if (
      Number.isNaN(
        startedAt,
      )
    ) {
      dueAccounts.push({
        account,

        lastStartedAt:
          null,
      });

      continue;
    }

    const minimumInterval =
      lastSync.error_code ===
        "orders_rate_limited"
        ? RATE_LIMIT_COOLDOWN_MS
        : MINIMUM_INTERVAL_MS;

    if (
      Date.now() -
      startedAt <
      minimumInterval
    ) {
      continue;
    }

    dueAccounts.push({
      account,

      lastStartedAt:
        startedAt,
    });
  }

  if (
    dueAccounts.length === 0
  ) {
    return {
      processed: false,

      reason:
        "not_due_yet",
    } as const;
  }

  /*
   * null = nunca sincronizou:
   * prioridade máxima.
   *
   * Depois vem a conta cujo último
   * orders_recent é mais antigo.
   */
  dueAccounts.sort(
    (left, right) => {
      if (
        left.lastStartedAt ===
        null &&
        right.lastStartedAt ===
        null
      ) {
        return left.account.code
          .localeCompare(
            right.account.code,
          );
      }

      if (
        left.lastStartedAt ===
        null
      ) {
        return -1;
      }

      if (
        right.lastStartedAt ===
        null
      ) {
        return 1;
      }

      return (
        left.lastStartedAt -
        right.lastStartedAt
      );
    },
  );

  const target =
    dueAccounts[0];

  const windowTo =
    new Date();

  const windowFrom =
    new Date(
      windowTo.getTime() -
      RECENT_ORDERS_WINDOW_MS,
    );

  let syncRunId:
    string | null = null;

  let offset = 0;

  let totalImportedOrders = 0;
  let totalImportedItems = 0;
  let totalMappedItems = 0;
  let totalUnmappedItems = 0;
  let sellerTotal = 0;
  let completedWindow =
  false;

  try {
    for (
      let page = 0;
      page < MAX_PAGES_PER_RUN;
      page++
    ) {
      const result =
        await syncOrdersPreview({
          organizationId:
            target.account
              .organization_id,

          mlAccountId:
            target.account.id,

          syncType:
            "orders_recent",

          limit:
            PAGE_SIZE,

          offset,

          dateCreatedFrom:
            windowFrom.toISOString(),

          dateCreatedTo:
            windowTo.toISOString(),

          existingSyncRunId:
            syncRunId,

          manageRunLifecycle:
            false,
        });

      syncRunId =
        result.syncRunId;

      totalImportedOrders +=
        result.importedOrders;

      totalImportedItems +=
        result.importedItems;

      totalMappedItems +=
        result.mappedItems;

      totalUnmappedItems +=
        result.unmappedItems;

      sellerTotal =
        result.sellerTotal;

      const nextOffset =
  offset +
  result.pageOrders;

if (syncRunId) {
  const {
    error:
      checkpointError,
  } = await admin
    .from(
      "sync_runs",
    )
    .update({
      records_discovered:
        sellerTotal,


      records_processed:
        totalImportedOrders,


      records_upserted:
        totalImportedOrders,


      cursor_offset:
        nextOffset,


      metadata: {
        mode:
          "incremental",


        limit:
          PAGE_SIZE,


        offset:
          nextOffset,


        date_created_from:
          windowFrom
            .toISOString(),


        date_created_to:
          windowTo
            .toISOString(),


        seller_total:
          sellerTotal,


        orders_imported:
          totalImportedOrders,


        order_items_imported:
          totalImportedItems,


        unmapped_order_items:
          totalUnmappedItems,


        last_page:
          page + 1,


        last_page_orders:
          result.pageOrders,


        last_page_finished_at:
          new Date()
            .toISOString(),
      },
    })
    .eq(
      "id",
      syncRunId,
    )
    .eq(
      "status",
      "running",
    );


  if (
    checkpointError
  ) {
    throw new Error(
      "Os pedidos foram processados, mas não foi possível salvar o checkpoint da sincronização.",
    );
  }
}

if (
  result.pageOrders <
    PAGE_SIZE ||
  nextOffset >=
    sellerTotal
) {
  offset =
    nextOffset;

  completedWindow =
    true;

  break;
}

offset += PAGE_SIZE;
    }

    if (
      !completedWindow
    ) {
      throw new Error(
        [
          "A janela recente contém mais pedidos",
          "do que o limite seguro desta execução.",
          `sellerTotal=${sellerTotal}.`,
          `processed=${totalImportedOrders}.`,
          "A sincronização foi interrompida",
          "para evitar perda silenciosa de dados.",
        ].join(" "),
      );
    }

    if (syncRunId) {
      await admin
        .from("sync_runs")
        .update({
          status:
            "succeeded",

          records_discovered:
            sellerTotal,

          records_processed:
            totalImportedOrders,

          records_upserted:
            totalImportedOrders,

          metadata: {
            mode:
              "incremental",

            limit:
              PAGE_SIZE,

            offset,

            date_created_from:
              windowFrom.toISOString(),

            date_created_to:
              windowTo.toISOString(),

            seller_total:
              sellerTotal,

            orders_imported:
              totalImportedOrders,

            order_items_imported:
              totalImportedItems,

            unmapped_order_items:
              totalUnmappedItems,
          },

          finished_at:
            new Date()
              .toISOString(),
        })
        .eq(
          "id",
          syncRunId,
        );
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Erro desconhecido.";

    const isRateLimited =
      /\bHTTP 429\b/i.test(
        errorMessage,
      );

    const isRequestTimeout =
      /\bREQUEST_TIMEOUT\b/i.test(
        errorMessage,
      );

    if (syncRunId) {
      await admin
        .from("sync_runs")
        .update({
          status:
            "failed",

          error_code:
            isRateLimited
              ? "orders_rate_limited"
              : isRequestTimeout
                ? "orders_request_timeout"
                : "orders_sync_failed",

          error_message:
            errorMessage,

          finished_at:
            new Date()
              .toISOString(),
        })
        .eq(
          "id",
          syncRunId,
        );
    }

    throw error;
  }

  return {
    processed: true,

    accountCode:
      target.account.code,

    importedOrders:
      totalImportedOrders,

    importedItems:
      totalImportedItems,

    mappedItems:
      totalMappedItems,

    unmappedItems:
      totalUnmappedItems,
  } as const;
}

/*
 * Compatibilidade temporária.
 *
 * O worker atual ainda importa este nome.
 * Mantemos o alias para não quebrar produção
 * antes de refatorarmos a rota do worker.
 */
export const syncRecentSbOrdersIfDue =
  syncRecentOrdersIfDue;