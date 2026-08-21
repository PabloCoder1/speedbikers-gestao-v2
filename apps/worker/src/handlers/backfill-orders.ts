import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { z } from "zod";

import type { Enqueuer } from "../enqueue.js";
import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { ceilToHour, fetchOrdersWindow, floorToHour } from "./ml-orders-fetch.js";
import { ensureAccessToken } from "./ml-token.js";
import { recordSyncRunFailure, recordSyncRunSuccess } from "./sync-runs.js";

/**
 * Backfill de pedidos: história, retomável, fila de prioridade baixa
 * (`docs/MERCADO_LIVRE.md` secao 3). Cobre o intervalo que a reconciliação
 * por janela não cobre — de `connected_at` para trás, até o limite de
 * retenção do Mercado Livre (12 meses).
 *
 * Uma execução não percorre 12 meses inteiros (o worker tem timeout de
 * 15 min, e o volume de uma conta ativa não cabe numa varredura só). Por
 * isso anda em PEDAÇOS de 7 dias: cada pedaço, ao terminar com sucesso,
 * avança `ml_accounts.backfill_covered_until` e enfileira o próximo pedaço
 * — decisão registrada nesta sessão (auto-encadeamento pelo próprio worker,
 * não pelo Cloud Scheduler, para não prender o backfill a um teto de um
 * pedaço por hora).
 */

const payloadSchema = z.object({ mlAccountId: z.uuid() });

/**
 * Retenção do Mercado Livre para pedidos: 12 meses (`docs/MERCADO_LIVRE.md`
 * secao 2.5). Ponto de partida do backfill quando `backfill_covered_until`
 * ainda é nulo — não adianta pedir data mais antiga, o Mercado Livre não
 * teria nada para devolver.
 */
const RETENTION_MS = 365 * 24 * 3_600_000;

/** Tamanho do pedaço. Grande o bastante para poucos pedaços (≈52 para 12 meses); pequeno o bastante para caber folgado no timeout do worker mesmo numa conta de alto volume. */
const CHUNK_SPAN_MS = 7 * 24 * 3_600_000;

export interface BackfillOrdersDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  enqueuer: Enqueuer;
  now?: () => Date;
}

export function createBackfillOrdersHandler(deps: BackfillOrdersDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem mlAccountId" };
    }

    const { mlAccountId } = parsed.data;
    const now = deps.now?.() ?? new Date();

    const account = await deps.db
      .from("ml_accounts")
      .select("id, organization_id, slug, seller_id, status, connected_at, backfill_covered_until")
      .eq("id", mlAccountId)
      .maybeSingle();

    if (account.error !== null || account.data === null) {
      context.logger.warn("backfill_orders_account_missing", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    if (
      account.data.status !== "CONNECTED" ||
      account.data.seller_id === null ||
      account.data.connected_at === null
    ) {
      // Desconectada entre o enfileiramento e a execução — corrida benigna,
      // não erro. O backfill não se reenfileira sozinho a partir daqui; uma
      // futura reconexão decide se retoma.
      context.logger.info("backfill_orders_account_not_connected", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    const {
      organization_id: organizationId,
      slug,
      seller_id: sellerId,
      connected_at: connectedAt,
      backfill_covered_until: coveredUntil,
    } = account.data;

    const connectedAtDate = new Date(connectedAt);

    if (coveredUntil !== null && new Date(coveredUntil).getTime() >= connectedAtDate.getTime()) {
      // Já cobriu tudo até onde a reconciliação assume — nada a fazer. Só
      // acontece se o job for reentregue depois do último pedaço já ter
      // decidido não reenfileirar mais nada.
      context.logger.info("backfill_orders_already_complete", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    const chunkFrom = floorToHour(
      coveredUntil !== null ? new Date(coveredUntil) : new Date(now.getTime() - RETENTION_MS),
    );
    const chunkTo = ceilToHour(
      new Date(Math.min(chunkFrom.getTime() + CHUNK_SPAN_MS, connectedAtDate.getTime())),
    );

    const started = now;
    const tokenResult = await ensureAccessToken(deps, mlAccountId, now);

    if (!tokenResult.ok) {
      await recordSyncRunFailure(deps.db, {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        resource: "orders",
        channel: "backfill",
        startedAt: started,
        finishedAt: deps.now?.() ?? new Date(),
        reason: tokenResult.reason,
        errorClass: tokenResult.retryable ? "retryable" : "not_retryable",
      });

      return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
    }

    let result;

    try {
      result = await fetchOrdersWindow({
        db: deps.db,
        organizationId,
        mlAccountId,
        mercadoLivre: deps.mercadoLivre,
        accessToken: tokenResult.accessToken,
        sellerId,
        from: chunkFrom,
        to: chunkTo,
        logger: context.logger,
      });
    } catch (error) {
      const finishedAt = deps.now?.() ?? new Date();
      const errorClass = error instanceof MercadoLivreApiError ? error.errorClass : "retryable";
      const reason = error instanceof Error ? error.message : "erro desconhecido ao buscar pedidos";

      await recordSyncRunFailure(deps.db, {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        resource: "orders",
        channel: "backfill",
        startedAt: started,
        finishedAt,
        reason,
        errorClass,
      });

      // Cloud Tasks repete O MESMO pedaço (mesma task, mesmo checkpoint) —
      // `backfill_covered_until` só avança depois de sucesso, então nada é
      // pulado.
      return { status: "failed", retryable: errorClass !== "not_retryable", reason };
    }

    const finishedAt = deps.now?.() ?? new Date();
    const partial = result.itemsSkipped > 0;

    await recordSyncRunSuccess(deps.db, {
      organizationId,
      mlAccountId,
      jobId: envelope.jobId,
      resource: "orders",
      channel: "backfill",
      itemsProcessed: result.itemsProcessed,
      latestRecordAt: result.latestRecordAt,
      startedAt: started,
      finishedAt,
      status: partial ? "partial" : "done",
      ...(partial
        ? { reason: `${String(result.itemsSkipped)} order(s) com formato inesperado, ignoradas` }
        : {}),
    });

    await deps.db
      .from("ml_accounts")
      .update({ backfill_covered_until: chunkTo.toISOString() })
      .eq("id", mlAccountId);

    const hasMore = chunkTo.getTime() < connectedAtDate.getTime();

    if (hasMore) {
      await deps.enqueuer.enqueue({
        jobType: "backfill.orders",
        organizationId,
        dedupeKey: `backfill-orders:${slug}:${chunkTo.toISOString()}`,
        queue: "backfill",
        payload: { mlAccountId },
      });
    }

    context.logger.info("backfill_orders_chunk_done", {
      ml_account_id: mlAccountId,
      chunk_from: chunkFrom.toISOString(),
      chunk_to: chunkTo.toISOString(),
      items_processed: result.itemsProcessed,
      items_skipped: result.itemsSkipped,
      has_more: hasMore,
    });

    return { status: "done", processed: result.itemsProcessed };
  };
}
