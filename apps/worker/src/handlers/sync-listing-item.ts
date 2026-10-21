import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { fetchListings } from "./ml-listings-fetch.js";
import { ensureAccessToken } from "./ml-token.js";

/**
 * `sync.listing.item` (D-631) — a notificação `items` do Mercado Livre vira a
 * leitura daquele anúncio, na hora: criado, alterado ou excluído.
 *
 * Antes, o tópico `items` chegava à `api` (milhares por dia) e era descartado
 * sem consumidor (D-179): o anúncio novo só aparecia na varredura de 6 em 6
 * horas, e o excluído nunca saía, porque a varredura não o devolve.
 *
 * A leitura é a MESMA da varredura (`fetchListings` com `itemIds`): o mesmo
 * multiget, a mesma promoção e descrição, os mesmos eventos de diff e a mesma
 * marca de exclusão (`closed` + `deleted`, ou 404). Não grava `sync_runs`: um
 * anúncio não tem janela nem frescor de catálogo — a varredura continua sendo
 * a rede de segurança.
 */

const payloadSchema = z.object({
  mlAccountId: z.uuid(),
  itemId: z.string().regex(/^MLB\d+$/),
});

export interface SyncListingItemDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
}

export function createSyncListingItemHandler(deps: SyncListingItemDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem mlAccountId/itemId válidos" };
    }

    const { mlAccountId, itemId } = parsed.data;
    const now = deps.now?.() ?? new Date();
    const account = await deps.db
      .from("ml_accounts")
      .select("id, organization_id, status, seller_id")
      .eq("id", mlAccountId)
      .maybeSingle();

    if (account.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao ler conta Mercado Livre: ${account.error.message}` };
    }

    if (account.data === null) {
      context.logger.warn("sync_listing_item_account_missing", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    if (account.data.organization_id !== envelope.organizationId) {
      return { status: "failed", retryable: false, reason: "mlAccountId não pertence à organizationId do job" };
    }

    if (account.data.status !== "CONNECTED") {
      return { status: "done", processed: 0 };
    }

    if (account.data.seller_id === null) {
      return { status: "failed", retryable: false, reason: "conta CONNECTED sem seller_id" };
    }

    const tokenResult = await ensureAccessToken(deps, mlAccountId, now);

    if (!tokenResult.ok) {
      return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
    }

    let result;

    try {
      result = await fetchListings({
        db: deps.db,
        organizationId: account.data.organization_id,
        mlAccountId,
        sellerId: account.data.seller_id,
        mercadoLivre: deps.mercadoLivre,
        accessToken: tokenResult.accessToken,
        logger: context.logger,
        itemIds: [itemId],
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      });
    } catch (error) {
      const errorClass = error instanceof MercadoLivreApiError ? error.errorClass : "retryable";

      return {
        status: "failed",
        retryable: errorClass !== "not_retryable",
        reason: error instanceof Error ? error.message : "erro desconhecido ao ler o anúncio",
      };
    }

    context.logger.info("sync_listing_item_done", {
      ml_account_id: mlAccountId,
      item_id: itemId,
      processed: result.itemsProcessed,
      marked_deleted: result.itemsMarkedDeleted,
      failed: result.itemsFailed,
    });

    // Falha POR ITEM (código do multiget ou payload) já foi registrada; repetir
    // devolve o mesmo, e a varredura de 6 h é a rede de segurança. Um item só:
    // gravado ou marcado excluído.
    return { status: "done", processed: Math.max(result.itemsProcessed, result.itemsMarkedDeleted) };
  };
}
