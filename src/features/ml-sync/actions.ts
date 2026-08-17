"use server";

import {
  revalidatePath,
} from "next/cache";

import { requireAdminAccess } from "@/features/auth/require-admin-access";
import { syncListingsPreview } from "@/features/ml-sync/sync-listings-preview";
import { syncOrdersPreview } from "@/features/ml-sync/sync-orders-preview";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOrdersHistoryRange } from "@/features/ml-sync/get-orders-history-range";
import {
  nextSaoPauloDayStartIso,
  saoPauloDateKey,
  saoPauloStartOfDayIso,
  shiftSaoPauloDateKey,
} from "@/lib/date/sao-paulo";

function earlierIsoDate(
  left: string,
  right: string,
) {
  return Date.parse(left) <
    Date.parse(right)
    ? left
    : right;
}

export type SyncListingsPreviewState = {
  error: string | null;
  success: string | null;
};

export type StartListingsSyncState = {
  error: string | null;
  success: string | null;
};

export async function startFullListingsSyncAction(
  mlAccountId: string,
  _previousState: StartListingsSyncState,
  _formData: FormData,
): Promise<StartListingsSyncState> {
  const access =
    await requireAdminAccess();

  const admin =
    createAdminClient();

  const {
    data: account,
    error: accountError,
  } = await admin
    .from("ml_accounts")
    .select(
      "id, connection_status",
    )
    .eq(
      "organization_id",
      access.organizationId,
    )
    .eq(
      "id",
      mlAccountId,
    )
    .maybeSingle();

  if (
    accountError ||
    !account
  ) {
    return {
      error:
        "Conta Mercado Livre não encontrada.",
      success: null,
    };
  }

  if (
    account.connection_status !==
    "connected"
  ) {
    return {
      error:
        "A conta Mercado Livre não está conectada.",
      success: null,
    };
  }

  const {
    error: insertError,
  } = await admin
    .from("sync_runs")
    .insert({
      organization_id:
        access.organizationId,

      ml_account_id:
        account.id,

      sync_type:
        "listings_full",

      status:
        "queued",

      cursor_offset:
        0,

      batch_size:
        50,

      retry_count:
        0,

      max_retries:
        5,

      requested_by:
        access.userId,

      metadata: {
        mode:
          "full",
      },
    });

  if (insertError) {
    if (
      insertError.code ===
      "23505"
    ) {
      return {
        error:
          "Já existe uma sincronização completa em andamento para esta conta.",
        success: null,
      };
    }

    return {
      error:
        "Não foi possível colocar a sincronização na fila.",
      success: null,
    };
  }

  revalidatePath(
    "/contas",
  );

  return {
    error: null,
    success:
      "Sincronização completa colocada na fila.",
  };
}

export async function syncListingsPreviewAction(
  mlAccountId: string,
  _previousState: SyncListingsPreviewState,
  _formData: FormData,
): Promise<SyncListingsPreviewState> {
  const access =
    await requireAdminAccess();

  try {
    const result =
      await syncListingsPreview({
        organizationId:
          access.organizationId,

        mlAccountId,
      });

    revalidatePath(
      "/contas",
    );

    return {
      error: null,

      success:
        [
          `${result.importedListings} anúncios importados.`,
          `${result.productsFound} SKUs encontrados.`,
          `${result.variationsFound} variações encontradas.`,
          `Total informado pelo seller: ${result.sellerTotal}.`,
        ].join(" "),
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Não foi possível sincronizar os anúncios.",

      success: null,
    };
  }
}

export type SyncOrdersPreviewState = {
  error: string | null;
  success: string | null;
};

export async function syncOrdersPreviewAction(
  mlAccountId: string,
  _previousState: SyncOrdersPreviewState,
  _formData: FormData,
): Promise<SyncOrdersPreviewState> {
  const access =
    await requireAdminAccess();

  try {
    const result =
      await syncOrdersPreview({
        organizationId:
          access.organizationId,

        mlAccountId,
      });

    revalidatePath(
      "/contas",
    );

    return {
      error: null,

      success:
        [
          `${result.importedOrders} pedidos importados.`,
          `${result.importedItems} itens encontrados.`,
          `${result.mappedItems} vinculados aos produtos.`,
          `${result.unmappedItems} sem vínculo.`,
          `Total informado pelo seller: ${result.sellerTotal}.`,
        ].join(" "),
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Não foi possível importar os pedidos.",

      success: null,
    };
  }
}
export type StartOrdersBackfillState = {
  error: string | null;
  success: string | null;
};

type MlAccountRow = {
  id: string;
  connection_status: string;
};

export async function startOrdersBackfillAction(
  mlAccountId: string,
  _previousState: StartOrdersBackfillState,
  _formData: FormData,
): Promise<StartOrdersBackfillState> {
  const access =
    await requireAdminAccess();


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
        "connection_status",
      ].join(","),
    )
    .eq(
      "organization_id",
      access.organizationId,
    )
    .eq(
      "id",
      mlAccountId,
    )
    .maybeSingle()) as {
      data: MlAccountRow | null;
      error: unknown;
    };


  if (
    accountError ||
    !account
  ) {
    return {
      error:
        "Conta Mercado Livre não encontrada.",

      success:
        null,
    };
  }

  if (
    account.connection_status !==
    "connected"
  ) {
    return {
      error:
        "A conta Mercado Livre não está conectada.",

      success:
        null,
    };
  }


  try {
    const range =
      await getOrdersHistoryRange({
        organizationId:
          access.organizationId,

        mlAccountId:
          account.id,
      });


    const historyFrom =
      saoPauloStartOfDayIso(
        saoPauloDateKey(range.oldestOrder.dateCreated),
      );


    /*
     * Half-open range:
     * [historyFrom, historyUntil)
     *
     * The next UTC day guarantees the
     * newest order itself is included.
     */
    const historyUntil =
      nextSaoPauloDayStartIso(range.newestOrder.dateCreated);


    const firstWindowTo =
      earlierIsoDate(
        nextSaoPauloDayStartIso(historyFrom),

        historyUntil,
      );


    const {
      error:
        insertError,
    } = await admin
      .from("sync_runs")
      .insert({
        organization_id:
          access.organizationId,

        ml_account_id:
          account.id,

        sync_type:
          "orders_backfill",

        status:
          "queued",

        cursor_offset:
          0,

        batch_size:
          50,

        records_discovered:
          range.total,

        records_processed:
          0,

        records_upserted:
          0,

        retry_count:
          0,

        max_retries:
          5,

        requested_by:
          access.userId,

        metadata: {
          mode:
            "backfill",

          history_from:
            historyFrom,

          history_until:
            historyUntil,

          window_from:
            historyFrom,

          window_to:
            firstWindowTo,

          window_days:
            1,

          completed_windows:
            0,

          snapshot_total:
            range.total,

          oldest_order_id:
            range.oldestOrder.id,

          newest_order_id:
            range.newestOrder.id,
        },
      });


    if (insertError) {
      if (
        insertError.code ===
        "23505"
      ) {
        return {
          error:
            "Já existe uma importação histórica de pedidos em andamento.",

          success:
            null,
        };
      }


      throw insertError;
    }


    revalidatePath(
      "/contas",
    );


    return {
      error:
        null,

      success:
        "Importação histórica colocada na fila. Ela continuará automaticamente no servidor.",
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Não foi possível iniciar a importação histórica.",

      success:
        null,
    };
  }
}

export type StartDashboardBackfillState = {
  error: string | null;
  success: string | null;
};


export async function startDashboardBackfillAction(
  mlAccountId: string,
  _previousState: StartDashboardBackfillState,
  _formData: FormData,
): Promise<StartDashboardBackfillState> {
  const access =
    await requireAdminAccess();


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
        "connection_status",
      ].join(","),
    )
    .eq(
      "organization_id",
      access.organizationId,
    )
    .eq(
      "id",
      mlAccountId,
    )
    .maybeSingle()) as {
      data: MlAccountRow | null;
      error: unknown;
    };


  if (
    accountError ||
    !account
  ) {
    return {
      error:
        "Conta Mercado Livre não encontrada.",

      success:
        null,
    };
  }


  if (
    account.connection_status !==
    "connected"
  ) {
    return {
      error:
        "A conta Mercado Livre não está conectada.",

      success:
        null,
    };
  }


  try {
    const today =
      saoPauloDateKey();


    const todayStart =
      saoPauloStartOfDayIso(today);


    /*
     * Half-open interval containing
     * today + previous 89 days.
     */
    const rangeUntil =
      saoPauloStartOfDayIso(shiftSaoPauloDateKey(today, 1));


    const rangeFrom =
      saoPauloStartOfDayIso(shiftSaoPauloDateKey(today, -89));


    const firstWindowTo =
      rangeUntil;


    const firstWindowFrom =
      todayStart;


    const {
      error:
        insertError,
    } = await admin
      .from("sync_runs")
      .insert({
        organization_id:
          access.organizationId,

        ml_account_id:
          account.id,

        sync_type:
          "orders_dashboard_backfill",

        status:
          "queued",

        cursor_offset:
          0,

        batch_size:
          50,

        records_discovered:
          0,

        records_processed:
          0,

        records_upserted:
          0,

        retry_count:
          0,

        max_retries:
          5,

        requested_by:
          access.userId,

        metadata: {
          mode:
            "dashboard_priority",

          range_from:
            rangeFrom,

          range_until:
            rangeUntil,

          window_from:
            firstWindowFrom,

          window_to:
            firstWindowTo,

          covered_from:
            null,

          target_windows:
            90,

          completed_windows:
            0,
        },
      });


    if (insertError) {
      if (
        insertError.code ===
        "23505"
      ) {
        return {
          error:
            "Já existe uma sincronização prioritária dos últimos 90 dias em andamento.",

          success:
            null,
        };
      }


      throw insertError;
    }


    revalidatePath(
      "/contas",
    );


    return {
      error:
        null,

      success:
        "Os últimos 90 dias foram colocados na fila prioritária.",
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Não foi possível iniciar a sincronização prioritária.",

      success:
        null,
    };
  }
}
