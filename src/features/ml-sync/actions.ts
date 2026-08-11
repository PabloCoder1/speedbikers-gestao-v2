"use server";

import {
  revalidatePath,
} from "next/cache";

import { requireAdminAccess } from "@/features/auth/require-admin-access";
import { syncListingsPreview } from "@/features/ml-sync/sync-listings-preview";
import { syncOrdersPreview } from "@/features/ml-sync/sync-orders-preview";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOrdersHistoryRange } from "@/features/ml-sync/get-orders-history-range";

function startOfUtcDay(
  value: string,
) {
  const date =
    new Date(
      value,
    );


  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
    ),
  ).toISOString();
}


function nextUtcDayStart(
  value: string,
) {
  const start =
    new Date(
      startOfUtcDay(
        value,
      ),
    );


  start.setUTCDate(
    start.getUTCDate() + 1,
  );


  return start.toISOString();
}


function addUtcDays(
  value: string,
  days: number,
) {
  const date =
    new Date(
      value,
    );


  date.setUTCDate(
    date.getUTCDate() +
      days,
  );


  return date.toISOString();
}


function earlierIsoDate(
  left: string,
  right: string,
) {
  return Date.parse(left) <
    Date.parse(right)
    ? left
    : right;
}

function getSaoPauloTodayKey() {
  const formatter =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "America/Sao_Paulo",

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit",
      },
    );


  const parts =
    formatter
      .formatToParts(
        new Date(),
      );


  const values =
    new Map(
      parts.map(
        (part) => [
          part.type,
          part.value,
        ],
      ),
    );


  const year =
    values.get("year");

  const month =
    values.get("month");

  const day =
    values.get("day");


  if (
    !year ||
    !month ||
    !day
  ) {
    throw new Error(
      "Não foi possível determinar a data atual de São Paulo.",
    );
  }


  return `${year}-${month}-${day}`;
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
      "id, code, connection_status",
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
    account.code !== "sb"
  ) {
    return {
      error:
        "Nesta fase a sincronização completa está liberada somente para a SB.",
      success: null,
    };
  }

  if (
    account.connection_status !==
    "connected"
  ) {
    return {
      error:
        "A conta SB não está conectada.",
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
          "Já existe uma sincronização completa em andamento para a SB.",
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
      "Sincronização completa da SB colocada na fila.",
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
  code: string;
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
        "code",
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
    account.code !== "sb"
  ) {
    return {
      error:
        "Nesta fase o histórico está habilitado somente para a SB.",

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
        "A conta SB não está conectada.",

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
      startOfUtcDay(
        range.oldestOrder
          .dateCreated,
      );


    /*
     * Half-open range:
     * [historyFrom, historyUntil)
     *
     * The next UTC day guarantees the
     * newest order itself is included.
     */
    const historyUntil =
      nextUtcDayStart(
        range.newestOrder
          .dateCreated,
      );


    const firstWindowTo =
      earlierIsoDate(
        addUtcDays(
          historyFrom,
          1,
        ),

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
        "code",
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
    account.code !== "sb"
  ) {
    return {
      error:
        "Nesta fase a priorização está habilitada somente para a SB.",

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
        "A conta SB não está conectada.",

      success:
        null,
    };
  }


  try {
    const today =
      getSaoPauloTodayKey();


    const todayStart =
      `${today}T00:00:00.000Z`;


    /*
     * Half-open interval containing
     * today + previous 89 days.
     */
    const rangeUntil =
      addUtcDays(
        todayStart,
        1,
      );


    const rangeFrom =
      addUtcDays(
        rangeUntil,
        -90,
      );


    const firstWindowTo =
      rangeUntil;


    const firstWindowFrom =
      addUtcDays(
        firstWindowTo,
        -1,
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
