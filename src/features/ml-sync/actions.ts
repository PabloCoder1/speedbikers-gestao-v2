"use server";

import {
  revalidatePath,
} from "next/cache";

import { requireAdminAccess } from "@/features/auth/require-admin-access";
import { syncListingsPreview } from "@/features/ml-sync/sync-listings-preview";

export type SyncListingsPreviewState = {
  error: string | null;
  success: string | null;
};

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