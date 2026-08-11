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
     * conta, não criamos outra concorrente.
     */
    if (
      lastSync?.status ===
      "running"
    ) {
      continue;
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

    if (
      Date.now() -
        startedAt <
      MINIMUM_INTERVAL_MS
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

  const result =
    await syncOrdersPreview({
      organizationId:
        target.account
          .organization_id,

      mlAccountId:
        target.account.id,

      syncType:
        "orders_recent",
    });

  return {
    processed: true,

    accountCode:
      target.account.code,

    importedOrders:
      result.importedOrders,

    importedItems:
      result.importedItems,

    mappedItems:
      result.mappedItems,

    unmappedItems:
      result.unmappedItems,
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