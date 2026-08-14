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

function isJsonObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function readString(
  value: unknown,
): string | null {
  return typeof value === "string"
    ? value
    : null;
}

function normalizeDate(
  value: string | null,
): string | null {
  if (!value) {
    return null;
  }

  const timestamp =
    Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(
    timestamp,
  ).toISOString();
}

function getPromotionRows(
  payload:
    MercadoLivreItemPromotionsResponse,
) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (
    Array.isArray(payload.results)
  ) {
    return payload.results.filter(
      isJsonObject,
    );
  }

  return [payload];
}

function findActivePromotionPayload({
  promotions,
  resolved,
}: {
  promotions:
    MercadoLivreItemPromotionsResponse;

  resolved:
    MercadoLivreResolvedPromotionState;
}) {
  const active =
    resolved.activePromotion;

  if (!active) {
    return null;
  }

  const rows =
    getPromotionRows(
      promotions,
    );

  return (
    rows.find((row) => {
      const id =
        readString(row.id);

      const type =
        readString(row.type);

      const status =
        readString(row.status);

      if (
        status !== "started"
      ) {
        return false;
      }

      if (
        active.id &&
        id !== active.id
      ) {
        return false;
      }

      if (
        active.type &&
        type !== active.type
      ) {
        return false;
      }

      return true;
    }) ?? null
  );
}

function getDetailsDate(
  details:
    MercadoLivrePromotionDetailsResponse | null,
  keys: string[],
) {
  if (!details) {
    return null;
  }

  for (const key of keys) {
    const value =
      readString(
        details[key],
      );

    if (value) {
      return normalizeDate(
        value,
      );
    }
  }

  return null;
}

function getDetailsString(
  details:
    MercadoLivrePromotionDetailsResponse | null,
  key: string,
) {
  if (!details) {
    return null;
  }

  return readString(
    details[key],
  );
}

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
  const admin =
    createAdminClient();

  const promotion =
    resolved.activePromotion;

  const capturedAt =
    new Date()
      .toISOString();

  const activePromotionPayload =
    findActivePromotionPayload({
      promotions,
      resolved,
    });

  const promotionStartedAt =
    getDetailsDate(
      activePromotionDetails,
      [
        "start_date",
        "startDate",
      ],
    ) ??
    normalizeDate(
      promotion?.startDate ??
        null,
    );

  const promotionEndsAt =
    getDetailsDate(
      activePromotionDetails,
      [
        "finish_date",
        "end_date",
        "finishDate",
        "endDate",
      ],
    ) ??
    normalizeDate(
      promotion?.finishDate ??
        null,
    );

  const promotionDeadlineAt =
    getDetailsDate(
      activePromotionDetails,
      [
        "deadline_date",
        "deadlineDate",
      ],
    );

  const promotionName =
    getDetailsString(
      activePromotionDetails,
      "name",
    ) ??
    promotion?.name ??
    null;

  const promotionStatus =
    getDetailsString(
      activePromotionDetails,
      "status",
    ) ??
    promotion?.status ??
    null;

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
    promotion_status: promotionStatus,
    promotion_name: promotionName,
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
    promotion_started_at: promotionStartedAt,
    promotion_ends_at: promotionEndsAt,
    promotion_deadline_at: promotionDeadlineAt,
    promotion_checked_at: capturedAt,
    active_promotion_payload: activePromotionPayload,
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
