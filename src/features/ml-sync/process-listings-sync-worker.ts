import "server-only";

import {
  randomUUID,
} from "node:crypto";

import { syncListingsPreview } from "@/features/ml-sync/sync-listings-preview";
import { createAdminClient } from "@/lib/supabase/admin";

const LEASE_SECONDS =
  120;

type SyncRunRow = {
  id: string;
  organization_id: string;
  ml_account_id: string;
  cursor_offset: number;
  batch_size: number;
  records_discovered: number;
  records_processed: number;
  records_upserted: number;
  retry_count: number;
  max_retries: number;
  metadata: unknown;
};

type SyncRunQueryResult = {
  data: SyncRunRow | null;
  error: unknown;
};

function asMetadata(
  value: unknown,
): Record<string, unknown> {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return value as
      Record<string, unknown>;
  }

  return {};
}

function calculateRetryDelaySeconds(
  retryCount: number,
) {
  return Math.min(
    30 *
      Math.pow(
        2,
        Math.max(
          0,
          retryCount - 1,
        ),
      ),
    15 * 60,
  );
}

export async function processNextListingsSyncBatch() {
  const admin =
    createAdminClient();

  const leaseId =
    randomUUID();

  const {
    data: syncRunId,
    error: claimError,
  } = await admin.rpc(
    "claim_next_listings_sync_run",
    {
      requested_lease_id:
        leaseId,

      lease_duration_seconds:
        LEASE_SECONDS,
    },
  );

  if (claimError) {
    throw new Error(
      "Não foi possível obter o próximo trabalho de sincronização.",
    );
  }

  if (!syncRunId) {
    return {
      processed: false,
      reason:
        "queue_empty",
    } as const;
  }

  const {
    data,
    error: runError,
  } = (await admin
    .from("sync_runs")
    .select(
      [
        "id",
        "organization_id",
        "ml_account_id",
        "cursor_offset",
        "batch_size",
        "records_discovered",
        "records_processed",
        "records_upserted",
        "retry_count",
        "max_retries",
        "metadata",
      ].join(","),
    )
    .eq(
      "id",
      syncRunId,
    )
    .eq(
      "lease_id",
      leaseId,
    )
    .maybeSingle()) as SyncRunQueryResult;

  if (
    runError ||
    !data
  ) {
    throw new Error(
      "O trabalho foi adquirido, mas não pôde ser carregado.",
    );
  }

  if (
    runError ||
    !data
  ) {
    throw new Error(
      "O trabalho foi adquirido, mas não pôde ser carregado.",
    );
  }

  const run = data;

  const currentMetadata =
    asMetadata(
      run.metadata,
    );

  const currentScrollId =
    typeof currentMetadata
      .scan_scroll_id ===
        "string" &&
    currentMetadata
      .scan_scroll_id
      .length > 0
      ? currentMetadata
          .scan_scroll_id
      : null;

  try {
    const result =
      await syncListingsPreview({
        organizationId:
          run.organization_id,

        mlAccountId:
          run.ml_account_id,

        limit:
          run.batch_size,

        existingSyncRunId:
          run.id,

        manageRunLifecycle:
          false,

        searchMode:
          "scan",

        scrollId:
          currentScrollId,
      });

    const newOffset =
      run.cursor_offset +
      result.pageItems;

    const newProcessed =
      run.records_processed +
      result.pageItems;

    const newUpserted =
      run.records_upserted +
      result.importedListings;

    const complete =
      result.pageItems === 0 ||
      newProcessed >=
        result.sellerTotal;

    if (
      !complete &&
      !result.nextScrollId
    ) {
      throw new Error(
        "O Mercado Livre não retornou scroll_id para continuar a sincronização completa.",
      );
    }

    const metadata = {
      ...currentMetadata,

      mode:
        "full",

      pagination:
        "scan",

      scan_scroll_id:
        complete
          ? null
          : result.nextScrollId,

      seller_total:
        result.sellerTotal,

      last_batch_progress_offset:
        run.cursor_offset,

      last_batch_items:
        result.pageItems,

      last_batch_persisted:
        result.importedListings,

      last_batch_products:
        result.productsFound,

      last_batch_variations:
        result.variationsFound,

      last_token_refreshed:
        result.tokenRefreshed,

      last_batch_finished_at:
        new Date()
          .toISOString(),
    };

    const {
      error:
        progressUpdateError,
    } = await admin
      .from("sync_runs")
      .update({
        cursor_offset:
          newOffset,

        records_discovered:
          result.sellerTotal,

        records_processed:
          newProcessed,

        records_upserted:
          newUpserted,

        retry_count:
          0,

        metadata,
      })
      .eq(
        "id",
        run.id,
      )
      .eq(
        "lease_id",
        leaseId,
      );

    if (
      progressUpdateError
    ) {
      throw new Error(
        "O lote foi importado, mas não foi possível salvar o checkpoint.",
      );
    }

    if (complete) {
      const {
        data: finalized,
        error:
          finalizeError,
      } = await admin.rpc(
        "finalize_listings_sync_run",
        {
          target_sync_run_id:
            run.id,

          requested_lease_id:
            leaseId,
        },
      );

      if (
        finalizeError ||
        !finalized
      ) {
        throw new Error(
          "A sincronização terminou, mas a reconciliação final falhou.",
        );
      }

      return {
        processed: true,
        completed: true,

        syncRunId:
          run.id,

        cursorOffset:
          newOffset,

        total:
          result.sellerTotal,

        batchItems:
          result.pageItems,
      } as const;
    }

    const {
      error: releaseError,
    } = await admin
      .from("sync_runs")
      .update({
        status:
          "queued",

        lease_id:
          null,

        lease_expires_at:
          null,

        next_attempt_at:
          new Date()
            .toISOString(),
      })
      .eq(
        "id",
        run.id,
      )
      .eq(
        "lease_id",
        leaseId,
      );

    if (releaseError) {
      throw new Error(
        "O lote foi concluído, mas não foi possível devolver o trabalho à fila.",
      );
    }

    return {
      processed: true,
      completed: false,

      syncRunId:
        run.id,

      cursorOffset:
        newOffset,

      total:
        result.sellerTotal,

      batchItems:
        result.pageItems,
    } as const;
  } catch (error) {
    const nextRetry =
      run.retry_count + 1;

    const failed =
      nextRetry >
      run.max_retries;

    const retryDelaySeconds =
      calculateRetryDelaySeconds(
        nextRetry,
      );

    const nextAttemptAt =
      new Date(
        Date.now() +
          retryDelaySeconds *
            1000,
      ).toISOString();

    await admin
      .from("sync_runs")
      .update({
        status:
          failed
            ? "failed"
            : "queued",

        retry_count:
          nextRetry,

        next_attempt_at:
          nextAttemptAt,

        lease_id:
          null,

        lease_expires_at:
          null,

        error_code:
          "listings_batch_failed",

        error_message:
          error instanceof Error
            ? error.message
            : "Erro desconhecido.",

        finished_at:
          failed
            ? new Date()
                .toISOString()
            : null,
      })
      .eq(
        "id",
        run.id,
      );

    throw error;
  }
}