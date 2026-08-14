import "server-only";

import type {
  MercadoLivreItemPromotionsResponse,
  MercadoLivrePromotionDetailsResponse,
  MercadoLivreResolvedPromotionState,
} from "@/integrations/mercado-livre/promotions";
import { createAdminClient } from "@/lib/supabase/admin";

type ListingPromotionStateInput = {
  id: string;
  organizationId: string;
  mlAccountId: string;
  productId: string | null;
  itemId: string;
  sellerSku: string | null;
  currencyId: string | null;
};

type PersistedPromotionState = {
  id: string;
};

export async function persistListingPromotionState({
  listing,
  resolved,
  promotions,
  activePromotionDetails,
}: {
  listing: ListingPromotionStateInput;
  resolved: MercadoLivreResolvedPromotionState;
  promotions: MercadoLivreItemPromotionsResponse;
  activePromotionDetails: MercadoLivrePromotionDetailsResponse | null;
}) {
  const admin = createAdminClient();
  const promotion = resolved.activePromotion;
  const capturedAt = new Date().toISOString();

  const row = {
    organization_id: listing.organizationId,
    ml_account_id: listing.mlAccountId,
    ml_listing_id: listing.id,
    ml_listing_variation_id: null,
    product_id: listing.productId,
    offer_scope: "listing",
    item_id: listing.itemId,
    variation_id: null,
    seller_sku: listing.sellerSku,
    currency_id: listing.currencyId,
    base_price: resolved.basePrice,
    effective_price: resolved.effectivePrice,
    has_active_promotion: resolved.hasActivePromotion,
    captured_at: capturedAt,
    promotion_resolution: resolved.resolution,
    promotion_id: promotion?.id ?? null,
    promotion_type: promotion?.type ?? null,
    promotion_sub_type: promotion?.subType ?? null,
    promotion_ref_id: promotion?.refId ?? null,
    promotion_status: promotion?.status ?? null,
    promotion_name: promotion?.name ?? null,
    promotion_original_price: promotion?.originalPrice ?? null,
    seller_percentage: promotion?.sellerPercentage ?? null,
    meli_percentage: promotion?.meliPercentage ?? null,
    boosted_offer: promotion?.boostedOffer ?? null,
    discount_meli_boosted_percentage:
      promotion?.discountMeliBoostedPercentage ?? null,
    discount_meli_boosted_amount:
      promotion?.discountMeliBoostedAmount ?? null,
    total_price_for_boosted_offer:
      promotion?.totalPriceForBoostedOffer ?? null,
    promotion_started_at: promotion?.startDate ?? null,
    promotion_ends_at: promotion?.finishDate ?? null,
    promotion_deadline_at: null,
    promotion_checked_at: capturedAt,
    active_promotion_payload: promotions,
    active_promotion_details_payload: activePromotionDetails,
  };

  const {
    data: existing,
    error: existingError,
  } = await admin
    .from("ml_offer_price_states")
    .select("id")
    .eq("organization_id", listing.organizationId)
    .eq("ml_account_id", listing.mlAccountId)
    .eq("ml_listing_id", listing.id)
    .eq("offer_scope", "listing")
    .maybeSingle<PersistedPromotionState>();


  if (existingError) {
    throw new Error(
      `Não foi possível verificar o estado promocional existente: ${existingError.message}`,
    );
  }


  if (existing) {
    const {
      data,
      error,
    } = await admin
      .from(
        "ml_offer_price_states",
      )
      .update(row)
      .eq(
        "id",
        existing.id,
      )
      .select("id")
      .single<PersistedPromotionState>();


    if (
      error ||
      !data
    ) {
      throw new Error(
        `Não foi possível atualizar o estado promocional: ${
          error?.message ??
          "registro não retornado"
        }`,
      );
    }


    return {
      id: data.id,
      operation:
        "updated" as const,
    };
  }


  const {
    data,
    error,
  } = await admin
    .from(
      "ml_offer_price_states",
    )
    .insert(row)
    .select("id")
    .single<PersistedPromotionState>();


  if (
    error ||
    !data
  ) {
    throw new Error(
      `Não foi possível inserir o estado promocional: ${
        error?.message ??
        "registro não retornado"
      }`,
    );
  }


  return {
    id: data.id,
    operation:
      "inserted" as const,
  };
}
