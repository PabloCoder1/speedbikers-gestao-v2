import "server-only";

import { createHash } from "node:crypto";

import type { ResolvedListingPriceState } from "@/features/ml-sync/resolve-listing-price-state";
import { createAdminClient } from "@/lib/supabase/admin";

type ListingInput = {
  id: string;
  organizationId: string;
  mlAccountId: string;
  productId: string | null;
  itemId: string;
  sellerSku: string | null;
  currencyId: string | null;
};
type PersistedPromotionState = { id: string };
type Snapshot = { id: string; state_hash: string };
export type OfferPriceRefreshSource =
  | "unknown"
  | "debug"
  | "backfill"
  | "notification"
  | "reconcile"
  | "manual";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString(value: unknown) { return typeof value === "string" ? value : null; }
function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
function sameMoneyValue(left: number, right: number) {
  return Math.round(left * 100) === Math.round(right * 100);
}
function normalizeDate(value: string | null) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}
function detailsString(details: Record<string, unknown> | null, key: string) {
  return details ? readString(details[key]) : null;
}
function detailsDate(details: Record<string, unknown> | null, keys: string[]) {
  for (const key of keys) {
    const value = detailsString(details, key);
    if (value) return normalizeDate(value);
  }
  return null;
}
function promotionRows(payload: Record<string, unknown> | Record<string, unknown>[]) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload.results) ? payload.results.filter(isObject) : [payload];
}

export async function persistListingPromotionState({
  listing,
  state,
  sourceSyncRunId = null,
  refreshSource,
  sourceRefreshJobId = null,
  notificationTopic = null,
}: {
  listing: ListingInput;
  state: ResolvedListingPriceState;
  sourceSyncRunId?: string | null;
  refreshSource?: OfferPriceRefreshSource;
  sourceRefreshJobId?: string | null;
  notificationTopic?: string | null;
}) {
  const admin = createAdminClient();
  const promotion = state.resolved.activePromotion;
  const capturedAt = new Date().toISOString();
  const resolvedRefreshSource = refreshSource ?? (sourceSyncRunId ? "backfill" : "debug");
  const promotionPayloadRows = promotionRows(state.promotionsPayload);
  let activePromotionPayload: Record<string, unknown> | null = null;
  if (promotion) {
    activePromotionPayload = promotionPayloadRows.find((row) => {
      const rowId = readString(row.id);
      const rowRefId = readString(row.ref_id);
      return readString(row.status) === "started" &&
        (!promotion.type || readString(row.type) === promotion.type) &&
        ((promotion.id !== null && rowId === promotion.id) ||
          (promotion.refId !== null && rowRefId === promotion.refId));
    }) ?? null;

    if (!activePromotionPayload && promotion.type) {
      const candidates = promotionPayloadRows.filter((row) =>
        readString(row.status) === "started" && readString(row.type) === promotion.type,
      );
      const expectedPrice = promotion.effectivePrice ?? promotion.price;
      if (expectedPrice !== null) {
        const priceMatches = candidates.filter((row) => {
          const rowPrice = readNumber(row.price);
          return rowPrice !== null && sameMoneyValue(rowPrice, expectedPrice);
        });
        if (priceMatches.length === 1) activePromotionPayload = priceMatches[0];
      }
      if (!activePromotionPayload && candidates.length === 1) activePromotionPayload = candidates[0];
    }
  }
  const details = state.activePromotionDetails;
  const promotionStartedAt = detailsDate(details, ["start_date", "startDate"]) ?? normalizeDate(promotion?.startDate ?? null);
  const promotionEndsAt = detailsDate(details, ["finish_date", "end_date", "finishDate", "endDate"]) ?? normalizeDate(promotion?.finishDate ?? null);
  const promotionDeadlineAt = detailsDate(details, ["deadline_date", "deadlineDate"]);
  const promotionName = detailsString(details, "name") ?? promotion?.name ?? null;
  const promotionStatus = detailsString(details, "status") ?? promotion?.status ?? null;

  const row = {
    organization_id: listing.organizationId, ml_account_id: listing.mlAccountId,
    ml_listing_id: listing.id, ml_listing_variation_id: null, product_id: listing.productId,
    offer_scope: "listing", item_id: listing.itemId, variation_id: null,
    seller_sku: listing.sellerSku, currency_id: listing.currencyId,
    base_price: state.basePriceDecision.basePrice, base_price_source: state.basePriceDecision.source,
    effective_price: state.resolved.effectivePrice, effective_price_source: state.resolved.effectivePriceSource,
    has_active_promotion: state.resolved.hasActivePromotion, captured_at: capturedAt,
    promotion_resolution: state.resolved.resolution, promotion_match_method: state.resolved.promotionMatchMethod,
    active_promotion_count: state.resolved.activePromotionCount,
    promotion_id: promotion?.id ?? null, promotion_type: promotion?.type ?? null,
    promotion_sub_type: promotion?.subType ?? null, promotion_ref_id: promotion?.refId ?? null,
    promotion_status: promotionStatus, promotion_name: promotionName,
    promotion_original_price: promotion?.originalPrice ?? null,
    seller_percentage: promotion?.sellerPercentage ?? null, meli_percentage: promotion?.meliPercentage ?? null,
    boosted_offer: promotion?.boostedOffer ?? null,
    discount_meli_boosted_percentage: promotion?.discountMeliBoostedPercentage ?? null,
    discount_meli_boosted_amount: promotion?.discountMeliBoostedAmount ?? null,
    total_price_for_boosted_offer: promotion?.totalPriceForBoostedOffer ?? null,
    promotion_started_at: promotionStartedAt, promotion_ends_at: promotionEndsAt,
    promotion_deadline_at: promotionDeadlineAt, promotion_checked_at: capturedAt,
    standard_price_resolution: state.standardPrice.resolution,
    standard_price_id: state.standardPrice.priceId,
    standard_price_last_updated: state.standardPrice.lastUpdated,
    sale_price_id: state.normalizedSalePrice.priceId,
    sale_price_regular_amount: state.normalizedSalePrice.regularAmount,
    sale_price_reference_at: state.normalizedSalePrice.referenceDate,
    sale_price_campaign_id: state.normalizedSalePrice.campaignId,
    sale_price_promotion_id: state.normalizedSalePrice.promotionId,
    sale_price_promotion_type: state.normalizedSalePrice.promotionType,
    sale_price_is_price_per_quantity: state.normalizedSalePrice.isPricePerQuantity,
    winning_offer_id: state.winningOffer?.id ?? null,
    winning_offer_promotion_id: state.winningOffer?.promotionId ?? null,
    winning_offer_type: state.winningOffer?.type ?? null,
    winning_offer_status: state.winningOffer?.status ?? null,
    winning_offer_error: state.winningOfferError,
    promotion_details_error: state.promotionDetailsError,
    price_checked_at: capturedAt,
    prices_payload: state.pricesPayload, sale_price_payload: state.salePricePayload,
    promotions_payload: state.promotionsPayload, winning_offer_payload: state.winningOfferPayload,
    active_promotion_payload: activePromotionPayload,
    active_promotion_details_payload: state.activePromotionDetails,
    source_sync_run_id: sourceSyncRunId,
    refresh_source: resolvedRefreshSource,
    source_refresh_job_id: sourceRefreshJobId,
    last_notification_topic: notificationTopic,
  };

  const { data: existing, error: existingError } = await admin.from("ml_offer_price_states")
    .select("id").eq("organization_id", listing.organizationId).eq("ml_account_id", listing.mlAccountId)
    .eq("ml_listing_id", listing.id).eq("offer_scope", "listing").maybeSingle<PersistedPromotionState>();
  if (existingError) throw new Error(`Não foi possível verificar o estado promocional existente: ${existingError.message}`);

  const { data, error } = await admin.from("ml_offer_price_states").upsert(row, {
    onConflict: "ml_listing_id,offer_scope,ml_listing_variation_id",
  }).select("id").single<PersistedPromotionState>();
  if (error || !data) throw new Error(`Não foi possível persistir o estado promocional: ${error?.message ?? "registro não retornado"}`);

  const materialState = {
    basePrice: state.basePriceDecision.basePrice, effectivePrice: state.resolved.effectivePrice,
    hasActivePromotion: state.resolved.hasActivePromotion, promotionResolution: state.resolved.resolution,
    promotionId: promotion?.id ?? null, promotionType: promotion?.type ?? null,
    promotionSubType: promotion?.subType ?? null, promotionStatus, promotionName,
    sellerPercentage: promotion?.sellerPercentage ?? null, meliPercentage: promotion?.meliPercentage ?? null,
    boostedOffer: promotion?.boostedOffer ?? null,
    discountMeliBoostedPercentage: promotion?.discountMeliBoostedPercentage ?? null,
    discountMeliBoostedAmount: promotion?.discountMeliBoostedAmount ?? null,
    totalPriceForBoostedOffer: promotion?.totalPriceForBoostedOffer ?? null,
    promotionStartedAt, promotionEndsAt,
    basePriceSource: state.basePriceDecision.source,
    effectivePriceSource: state.resolved.effectivePriceSource,
    promotionMatchMethod: state.resolved.promotionMatchMethod,
    activePromotionCount: state.resolved.activePromotionCount,
    salePriceCampaignId: state.normalizedSalePrice.campaignId,
    salePricePromotionId: state.normalizedSalePrice.promotionId,
    salePricePromotionType: state.normalizedSalePrice.promotionType,
  };
  const stateHash = createHash("sha256").update(JSON.stringify(materialState)).digest("hex");
  const { data: previousSnapshot, error: snapshotReadError } = await admin.from("ml_offer_price_state_snapshots")
    .select("id,state_hash").eq("ml_listing_id", listing.id)
    .order("captured_at", { ascending: false }).limit(1).maybeSingle<Snapshot>();
  if (snapshotReadError) throw new Error(`Não foi possível verificar o histórico promocional: ${snapshotReadError.message}`);
  let snapshotInserted = false;
  if (previousSnapshot?.state_hash !== stateHash) {
    const { error: snapshotError } = await admin.from("ml_offer_price_state_snapshots").insert({
      organization_id: listing.organizationId, ml_account_id: listing.mlAccountId,
      ml_listing_id: listing.id, product_id: listing.productId, item_id: listing.itemId,
      seller_sku: listing.sellerSku, currency_id: listing.currencyId,
      base_price: state.basePriceDecision.basePrice, effective_price: state.resolved.effectivePrice,
      has_active_promotion: state.resolved.hasActivePromotion, promotion_resolution: state.resolved.resolution,
      promotion_id: promotion?.id ?? null, promotion_type: promotion?.type ?? null,
      promotion_sub_type: promotion?.subType ?? null, promotion_status: promotionStatus,
      promotion_name: promotionName, seller_percentage: promotion?.sellerPercentage ?? null,
      meli_percentage: promotion?.meliPercentage ?? null, boosted_offer: promotion?.boostedOffer ?? null,
      discount_meli_boosted_percentage: promotion?.discountMeliBoostedPercentage ?? null,
      discount_meli_boosted_amount: promotion?.discountMeliBoostedAmount ?? null,
      total_price_for_boosted_offer: promotion?.totalPriceForBoostedOffer ?? null,
      promotion_started_at: promotionStartedAt, promotion_ends_at: promotionEndsAt,
      base_price_source: state.basePriceDecision.source,
      effective_price_source: state.resolved.effectivePriceSource,
      promotion_match_method: state.resolved.promotionMatchMethod,
      active_promotion_count: state.resolved.activePromotionCount,
      sale_price_campaign_id: state.normalizedSalePrice.campaignId,
      sale_price_promotion_id: state.normalizedSalePrice.promotionId,
      sale_price_promotion_type: state.normalizedSalePrice.promotionType,
      state_hash: stateHash, state_payload: materialState, captured_at: capturedAt,
      source_sync_run_id: sourceSyncRunId,
      refresh_source: resolvedRefreshSource,
      source_refresh_job_id: sourceRefreshJobId,
    });
    if (snapshotError && snapshotError.code !== "23505") {
      throw new Error(`Não foi possível registrar o histórico promocional: ${snapshotError.message}`);
    }
    snapshotInserted = !snapshotError;
  }

  return { id: data.id, operation: existing ? "updated" as const : "inserted" as const, snapshotInserted };
}
