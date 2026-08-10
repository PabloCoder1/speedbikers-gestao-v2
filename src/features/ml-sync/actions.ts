"use server";

import {
  revalidatePath,
} from "next/cache";

import { requireAdminAccess } from "@/features/auth/require-admin-access";
import { syncListingsPreview } from "@/features/ml-sync/sync-listings-preview";
import { syncOrdersPreview } from "@/features/ml-sync/sync-orders-preview";
import { createAdminClient } from "@/lib/supabase/admin";

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
