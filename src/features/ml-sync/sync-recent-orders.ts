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

const MINIMUM_INTERVAL_MS =
  4 * 60 * 1000;


export async function syncRecentSbOrdersIfDue() {
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
        "connection_status",
      ].join(","),
    )
    .eq(
      "code",
      "sb",
    )
    .maybeSingle()) as {
      data: RecentOrdersAccountRow | null;
      error: unknown;
    };


  if (
    accountError ||
    !account
  ) {
    throw new Error(
      "Conta SB não encontrada.",
    );
  }


  if (
    account.connection_status !==
    "connected"
  ) {
    return {
      processed: false,
      reason:
        "account_not_connected",
    } as const;
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
      data: RecentOrdersSyncRunRow | null;
      error: unknown;
    };


  if (lastSyncError) {
    throw new Error(
      "Não foi possível verificar a última sincronização de pedidos.",
    );
  }


  if (
    lastSync?.status ===
    "running"
  ) {
    return {
      processed: false,
      reason:
        "already_running",
    } as const;
  }


  if (lastSync) {
    const startedAt =
      Date.parse(
        lastSync.started_at,
      );


    if (
      !Number.isNaN(
        startedAt,
      ) &&
      Date.now() -
        startedAt <
        MINIMUM_INTERVAL_MS
    ) {
      return {
        processed: false,
        reason:
          "not_due_yet",
      } as const;
    }
  }


  const result =
    await syncOrdersPreview({
      organizationId:
        account.organization_id,

      mlAccountId:
        account.id,

      syncType:
        "orders_recent",
    });


  return {
    processed: true,

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