import "server-only";

import { randomUUID } from "node:crypto";

import { persistListingPromotionState } from "@/features/ml-sync/persist-listing-promotion-state";
import { resolveListingPriceState } from "@/features/ml-sync/resolve-listing-price-state";
import { getValidMercadoLivreAccessToken } from "@/integrations/mercado-livre/access-token";
import { getMercadoLivrePromotionOffer } from "@/integrations/mercado-livre/promotions";
import { createAdminClient } from "@/lib/supabase/admin";

const LEASE_SECONDS = 120;

type RefreshJob = {
  id: string;
  organization_id: string;
  ml_account_id: string;
  item_id: string | null;
  offer_id: string | null;
  reason: "items_prices" | "public_offers" | "manual";
  topic: string | null;
  attempt_count: number;
  max_attempts: number;
};

type ListingRow = {
  id: string;
  product_id: string | null;
  item_id: string;
  seller_sku: string | null;
  currency_id: string | null;
  price: number | string | null;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 500) : "Erro desconhecido";
}

function legacyPrice(value: number | string | null) {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function retryDelaySeconds(attemptCount: number) {
  const base = 30 * Math.pow(2, Math.max(0, attemptCount - 1));
  const jitter = Math.floor(Math.random() * 16);
  return Math.min(base + jitter, 15 * 60);
}

function safeItemHint(value: string | null) {
  if (!value) return null;
  return /^MLB[0-9]+$/.test(value) ? value : null;
}

export async function processNextOfferRefreshJob() {
  const admin = createAdminClient();
  const leaseId = randomUUID();
  const { data: jobId, error: claimError } = await admin.rpc(
    "claim_next_ml_offer_refresh_job",
    {
      requested_lease_id: leaseId,
      lease_duration_seconds: LEASE_SECONDS,
    },
  );

  if (claimError) {
    throw new Error(`REFRESH_JOB_CLAIM_FAILED: ${claimError.message}`);
  }
  if (!jobId) return { processed: false, reason: "queue_empty" } as const;

  const { data: job, error: jobError } = await admin
    .from("ml_offer_refresh_jobs")
    .select(
      "id,organization_id,ml_account_id,item_id,offer_id,reason,topic,attempt_count,max_attempts",
    )
    .eq("id", jobId)
    .eq("lease_id", leaseId)
    .maybeSingle<RefreshJob>();

  if (jobError || !job) {
    throw new Error("REFRESH_JOB_LOAD_FAILED");
  }

  const finish = async ({
    status,
    errorCode = null,
    message = null,
    listingId = null,
  }: {
    status: "succeeded" | "ignored";
    errorCode?: string | null;
    message?: string | null;
    listingId?: string | null;
  }) => {
    const { error } = await admin
      .from("ml_offer_refresh_jobs")
      .update({
        status,
        ml_listing_id: listingId,
        lease_id: null,
        lease_expires_at: null,
        error_code: errorCode,
        error_message: message,
        processed_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("lease_id", leaseId);
    if (error) throw new Error(`REFRESH_JOB_FINISH_FAILED: ${error.message}`);
  };

  try {
    const token = await getValidMercadoLivreAccessToken(job.ml_account_id);
    let itemId = safeItemHint(job.item_id);

    if (job.offer_id) {
      try {
        const offer = await getMercadoLivrePromotionOffer({
          offerId: job.offer_id,
          accessToken: token.accessToken,
        });
        const officialItemId = safeItemHint(offer.normalized.itemId);
        if (officialItemId && itemId && officialItemId !== itemId) {
          throw new Error(
            `OFFER_ITEM_MISMATCH: ${job.offer_id} pertence a ${officialItemId}, nao a ${itemId}.`,
          );
        }
        itemId = officialItemId ?? itemId;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("OFFER_ITEM_MISMATCH:")
        ) {
          throw error;
        }
        if (!itemId) {
          throw new Error(`OFFER_LOOKUP_FAILED: ${errorMessage(error)}`);
        }
      }
    }

    if (!itemId) throw new Error("REFRESH_ITEM_UNRESOLVED");

    const { data: listing, error: listingError } = await admin
      .from("ml_listings")
      .select("id,product_id,item_id,seller_sku,currency_id,price")
      .eq("organization_id", job.organization_id)
      .eq("ml_account_id", job.ml_account_id)
      .eq("item_id", itemId)
      .eq("is_current", true)
      .maybeSingle<ListingRow>();

    if (listingError) {
      throw new Error(`LISTING_QUERY_FAILED: ${listingError.message}`);
    }
    if (!listing) {
      await finish({
        status: "ignored",
        errorCode: "listing_not_current",
        message: "O MLB nao pertence a uma listing atual desta conta.",
      });
      return {
        processed: true,
        status: "ignored",
        reason: "listing_not_current",
        jobId: job.id,
      } as const;
    }

    const state = await resolveListingPriceState({
      itemId: listing.item_id,
      legacyListingPrice: legacyPrice(listing.price),
      accessToken: token.accessToken,
    });
    const persisted = await persistListingPromotionState({
      listing: {
        id: listing.id,
        organizationId: job.organization_id,
        mlAccountId: job.ml_account_id,
        productId: listing.product_id,
        itemId: listing.item_id,
        sellerSku: listing.seller_sku,
        currencyId: listing.currency_id,
      },
      state,
      sourceSyncRunId: null,
      refreshSource: "notification",
      sourceRefreshJobId: job.id,
      notificationTopic: job.topic,
    });

    await finish({ status: "succeeded", listingId: listing.id });
    return {
      processed: true,
      status: "succeeded",
      jobId: job.id,
      itemId: listing.item_id,
      persisted,
    } as const;
  } catch (error) {
    const exhausted = job.attempt_count >= job.max_attempts;
    const message = errorMessage(error);
    const errorCode = message.startsWith("OFFER_ITEM_MISMATCH:")
      ? "offer_item_mismatch"
      : message.startsWith("OFFER_LOOKUP_FAILED:")
        ? "offer_lookup_failed"
        : "offer_refresh_failed";
    const { error: retryError } = await admin
      .from("ml_offer_refresh_jobs")
      .update({
        status: exhausted ? "failed" : "queued",
        lease_id: null,
        lease_expires_at: null,
        next_attempt_at: new Date(
          Date.now() + retryDelaySeconds(job.attempt_count) * 1000,
        ).toISOString(),
        error_code: errorCode,
        error_message: message,
        processed_at: exhausted ? new Date().toISOString() : null,
      })
      .eq("id", job.id)
      .eq("lease_id", leaseId);

    if (retryError) {
      throw new Error(`REFRESH_JOB_RETRY_FAILED: ${retryError.message}`);
    }
    return {
      processed: true,
      status: exhausted ? "failed" : "queued",
      retrying: !exhausted,
      attempt: job.attempt_count,
      jobId: job.id,
      error: errorCode,
    } as const;
  }
}
