import "server-only";

import { MERCADO_LIVRE_URLS } from "./constants";
import type {
  MercadoLivreNormalizedSalePrice,
} from "./items";


const DEFAULT_TIMEOUT_MS = 15_000;


/*
 * Propositalmente genérico.
 *
 * Ainda não sabemos o formato exato retornado por cada
 * modalidade de promoção brasileira. Primeiro vemos o
 * payload real, depois tipamos.
 */
export type MercadoLivreItemPromotionsResponse =
  | Record<string, unknown>
  | Record<string, unknown>[];


function isJsonObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}


export type MercadoLivreNormalizedPromotion = {
  id: string | null;


  type: string | null;
  subType: string | null;


  refId: string | null;


  status: string | null;


  /*
   * Preço da oferta/campanha retornado pelo Mercado Livre.
   * Não necessariamente é o preço final ao comprador caso
   * exista boosted_offer.
   */
  price: number | null;


  /*
   * Preço realmente considerado pelo resolver.
   *
   * boosted_offer = true
   * → total_price_for_boosted_offer
   *
   * caso contrário
   * → price
   */
  effectivePrice: number | null;


  originalPrice: number | null;


  sellerPercentage: number | null;
  meliPercentage: number | null;


  boostedOffer: boolean | null;


  discountMeliBoostedPercentage:
    number | null;


  discountMeliBoostedAmount:
    number | null;


  totalPriceForBoostedOffer:
    number | null;


  startDate: string | null;
  finishDate: string | null;


  name: string | null;
};


export type MercadoLivreResolvedPromotionState = {
  basePrice: number | null;
  effectivePrice: number | null;
  discountPercent: number | null;
  hasActivePromotion: boolean;
  resolution:
    | "no_active_promotion"
    | "active_promotion_without_price"
    | "ambiguous_multiple_active_prices"
    | "active_promotion"
    | "sale_price_promotion_unmatched"
    | "started_promotion_not_winning";
  effectivePriceSource:
    | "sale_price"
    | "promotion_fallback"
    | "base_price_fallback"
    | "unresolved";
  promotionMatchMethod:
    | "none"
    | "campaign_id"
    | "offer_lookup"
    | "promotion_ref_id"
    | "price_match"
    | "single_started";
  salePriceHasPromotionSignal: boolean;
  activePromotion:
    | MercadoLivreNormalizedPromotion
    | null;
  activePromotionCount: number;
};

export type MercadoLivreNormalizedPromotionOffer = {
  id: string | null;
  itemId: string | null;
  promotionId: string | null;
  type: string | null;
  status: string | null;
};


function readString(
  value: unknown,
): string | null {
  return typeof value === "string"
    ? value
    : null;
}


function readFiniteNumber(
  value: unknown,
): number | null {
  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return value;
  }


  if (
    typeof value === "string" &&
    value.trim()
  ) {
    const parsed = Number(value);


    return Number.isFinite(parsed)
      ? parsed
      : null;
  }


  return null;
}


function readBoolean(
  value: unknown,
): boolean | null {
  return typeof value === "boolean"
    ? value
    : null;
}


function getPromotionPrice(
  promotion: Record<string, unknown>,
): number | null {
  const directPrice =
    readFiniteNumber(promotion.price) ??
    readFiniteNumber(promotion.deal_price) ??
    readFiniteNumber(promotion.new_price);


  if (directPrice !== null) {
    return directPrice;
  }


  if (!Array.isArray(promotion.offers)) {
    return null;
  }


  const activeOffer = promotion.offers.find(
    (offer) =>
      isJsonObject(offer) &&
      (
        offer.status === "active" ||
        offer.status === "started"
      ),
  );


  if (!isJsonObject(activeOffer)) {
    return null;
  }


  return (
    readFiniteNumber(activeOffer.new_price) ??
    readFiniteNumber(activeOffer.price) ??
    readFiniteNumber(activeOffer.deal_price)
  );
}


function getPromotionEffectivePrice(
  promotion: Record<string, unknown>,
): number | null {
  const boostedOffer =
    readBoolean(
      promotion.boosted_offer,
    );


  if (boostedOffer === true) {
    const boostedPrice =
      readFiniteNumber(
        promotion.total_price_for_boosted_offer,
      );


    /*
     * Se o Mercado Livre disser explicitamente que existe
     * boost, mas não fornecer o preço final correspondente,
     * não devemos fingir que o preço normal da campanha é
     * o preço efetivo.
     */
    if (
      boostedPrice === null ||
      boostedPrice <= 0
    ) {
      return null;
    }


    return boostedPrice;
  }


  return getPromotionPrice(
    promotion,
  );
}


function normalizePromotion(
  promotion: Record<string, unknown>,
): MercadoLivreNormalizedPromotion {
  return {
    id:
      readString(
        promotion.id,
      ),


    type:
      readString(
        promotion.type,
      ),


    subType:
      readString(
        promotion.sub_type,
      ),


    refId:
      readString(
        promotion.ref_id,
      ),


    status:
      readString(
        promotion.status,
      ),


    price:
      getPromotionPrice(
        promotion,
      ),


    effectivePrice:
      getPromotionEffectivePrice(
        promotion,
      ),


    originalPrice:
      readFiniteNumber(
        promotion.original_price,
      ),


    sellerPercentage:
      readFiniteNumber(
        promotion.seller_percentage,
      ),


    meliPercentage:
      readFiniteNumber(
        promotion.meli_percentage,
      ),


    boostedOffer:
      readBoolean(
        promotion.boosted_offer,
      ),


    discountMeliBoostedPercentage:
      readFiniteNumber(
        promotion.discount_meli_boosted_percentage,
      ),


    discountMeliBoostedAmount:
      readFiniteNumber(
        promotion.discount_meli_boost_amount,
      ),


    totalPriceForBoostedOffer:
      readFiniteNumber(
        promotion.total_price_for_boosted_offer,
      ),


    startDate:
      readString(
        promotion.start_date,
      ),


    finishDate:
      readString(
        promotion.finish_date,
      ) ??
      readString(
        promotion.end_date,
      ),


    name:
      readString(
        promotion.name,
      ),
  };
}


export function normalizeMercadoLivreItemPromotions(
  payload: MercadoLivreItemPromotionsResponse,
) {
  const rawPromotions = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.results)
      ? payload.results.filter(isJsonObject)
      : [payload];
  return rawPromotions.map(normalizePromotion);
}


function sameMoneyValue(
  left: number,
  right: number,
) {
  return (
    Math.round(left * 100) ===
    Math.round(right * 100)
  );
}


function calculateDiscountPercent({
  basePrice,
  effectivePrice,
}: {
  basePrice: number | null;
  effectivePrice: number | null;
}) {
  if (
    basePrice === null ||
    basePrice <= 0 ||
    effectivePrice === null ||
    effectivePrice >= basePrice
  ) {
    return null;
  }

  return (
    Math.round(
      (
        (
          (
            basePrice -
            effectivePrice
          ) /
          basePrice
        ) *
        100
      ) *
        100,
    ) / 100
  );
}


export function resolveMercadoLivrePromotionState({
  basePrice,
  payload,
  salePrice = null,
  winningOffer = null,
}: {
  basePrice: number | null;

  payload:
    MercadoLivreItemPromotionsResponse;

  salePrice?:
    MercadoLivreNormalizedSalePrice | null;
  winningOffer?:
    MercadoLivreNormalizedPromotionOffer | null;
}): MercadoLivreResolvedPromotionState {
  const startedPromotions =
    normalizeMercadoLivreItemPromotions(payload)
      .filter(
        (promotion) =>
          promotion.status ===
          "started",
      );

  const saleAmount =
    salePrice?.amount !== null &&
    salePrice?.amount !== undefined &&
    salePrice.amount > 0
      ? salePrice.amount
      : null;

  const salePriceHasPromotionSignal = Boolean(
    salePrice?.campaignId ||
    salePrice?.promotionId ||
    (salePrice?.regularAmount !== null && salePrice?.regularAmount !== undefined && saleAmount !== null && saleAmount < salePrice.regularAmount) ||
    (basePrice !== null && saleAmount !== null && saleAmount < basePrice),
  );

  if (
    startedPromotions.length === 0
  ) {
    const effectivePrice =
      saleAmount ??
      basePrice;

    return {
      basePrice,
      effectivePrice,
      discountPercent:
        calculateDiscountPercent({
          basePrice,
          effectivePrice,
        }),
      hasActivePromotion:
        salePriceHasPromotionSignal,
      resolution:
        salePriceHasPromotionSignal
          ? effectivePrice === null
            ? "active_promotion_without_price"
            : "sale_price_promotion_unmatched"
          : "no_active_promotion",
      effectivePriceSource: saleAmount !== null ? "sale_price" : basePrice !== null ? "base_price_fallback" : "unresolved",
      promotionMatchMethod: "none",
      salePriceHasPromotionSignal,
      activePromotion: null,
      activePromotionCount: 0,
    };
  }

  let winningPromotion:
    MercadoLivreNormalizedPromotion | null =
      null;
  let promotionMatchMethod: MercadoLivreResolvedPromotionState["promotionMatchMethod"] = "none";

  if (
    salePrice?.campaignId
  ) {
    winningPromotion =
      startedPromotions.find(
        (promotion) =>
          promotion.id ===
          salePrice.campaignId,
      ) ??
      null;
    if (winningPromotion) promotionMatchMethod = "campaign_id";
  }

  if (
    !winningPromotion &&
    salePrice?.promotionId
  ) {
    winningPromotion =
      startedPromotions.find(
        (promotion) =>
          promotion.refId ===
            salePrice.promotionId ||
          promotion.id ===
            salePrice.promotionId,
      ) ??
      null;
    if (winningPromotion) promotionMatchMethod = "promotion_ref_id";
  }

  if (!winningPromotion && winningOffer?.promotionId) {
    winningPromotion = startedPromotions.find(
      (promotion) => promotion.id === winningOffer.promotionId || promotion.refId === winningOffer.promotionId,
    ) ?? null;
    if (winningPromotion) promotionMatchMethod = "offer_lookup";
  }

  if (
    !winningPromotion &&
    saleAmount !== null
  ) {
    const priceMatches =
      startedPromotions.filter(
        (promotion) =>
          promotion.effectivePrice !== null &&
          sameMoneyValue(
            promotion.effectivePrice,
            saleAmount,
          ),
      );

    if (
      priceMatches.length === 1
    ) {
      winningPromotion =
        priceMatches[0];
      promotionMatchMethod = "price_match";
    }
  }

  if (
    !winningPromotion &&
    startedPromotions.length === 1 &&
    (salePriceHasPromotionSignal || saleAmount === null)
  ) {
    winningPromotion =
      startedPromotions[0];
    promotionMatchMethod = "single_started";
  }

  if (winningPromotion) {
    const effectivePrice =
      saleAmount ??
      winningPromotion.effectivePrice;

    return {
      basePrice,
      effectivePrice,
      discountPercent:
        calculateDiscountPercent({
          basePrice,
          effectivePrice,
        }),
      hasActivePromotion: true,
      resolution:
        effectivePrice === null
          ? "active_promotion_without_price"
          : "active_promotion",
      effectivePriceSource: saleAmount !== null ? "sale_price" : effectivePrice !== null ? "promotion_fallback" : "unresolved",
      promotionMatchMethod,
      salePriceHasPromotionSignal,
      activePromotion: winningPromotion,
      activePromotionCount:
        startedPromotions.length,
    };
  }

  if (
    salePriceHasPromotionSignal
  ) {
    return {
      basePrice,
      effectivePrice: saleAmount,
      discountPercent:
        calculateDiscountPercent({
          basePrice,
          effectivePrice: saleAmount,
        }),
      hasActivePromotion: true,
      resolution: saleAmount === null ? "active_promotion_without_price" : "sale_price_promotion_unmatched",
      effectivePriceSource: saleAmount !== null ? "sale_price" : "unresolved",
      promotionMatchMethod: "none",
      salePriceHasPromotionSignal,
      activePromotion: null,
      activePromotionCount:
        startedPromotions.length,
    };
  }

  if (saleAmount !== null) {
    return {
      basePrice,
      effectivePrice: saleAmount,
      discountPercent: calculateDiscountPercent({ basePrice, effectivePrice: saleAmount }),
      hasActivePromotion: false,
      resolution: "started_promotion_not_winning",
      effectivePriceSource: "sale_price",
      promotionMatchMethod: "none",
      salePriceHasPromotionSignal,
      activePromotion: null,
      activePromotionCount: startedPromotions.length,
    };
  }

  const promotionsWithPrice =
    startedPromotions.filter(
      (
        promotion,
      ): promotion is
        MercadoLivreNormalizedPromotion & {
          effectivePrice: number;
        } =>
        promotion.effectivePrice !== null &&
        promotion.effectivePrice > 0,
    );

  if (
    promotionsWithPrice.length === 0
  ) {
    return {
      basePrice,
      effectivePrice: null,
      discountPercent: null,
      hasActivePromotion: true,
      resolution:
        "active_promotion_without_price",
      effectivePriceSource: "unresolved",
      promotionMatchMethod: "none",
      salePriceHasPromotionSignal,
      activePromotion: null,
      activePromotionCount:
        startedPromotions.length,
    };
  }

  const uniquePrices =
    Array.from(
      new Set(
        promotionsWithPrice.map(
          (promotion) =>
            promotion.effectivePrice,
        ),
      ),
    );

  if (
    uniquePrices.length > 1
  ) {
    return {
      basePrice,
      effectivePrice: null,
      discountPercent: null,
      hasActivePromotion: true,
      resolution:
        "ambiguous_multiple_active_prices",
      effectivePriceSource: "unresolved",
      promotionMatchMethod: "none",
      salePriceHasPromotionSignal,
      activePromotion: null,
      activePromotionCount:
        startedPromotions.length,
    };
  }

  const activePromotion =
    promotionsWithPrice[0];

  const effectivePrice =
    activePromotion.effectivePrice;

  return {
    basePrice,
    effectivePrice,
    discountPercent:
      calculateDiscountPercent({
        basePrice,
        effectivePrice,
      }),
    hasActivePromotion: true,
    resolution: "active_promotion",
    effectivePriceSource: "promotion_fallback",
    promotionMatchMethod: "price_match",
    salePriceHasPromotionSignal,
    activePromotion,
    activePromotionCount:
      startedPromotions.length,
  };
}


export async function getMercadoLivreItemPromotions({
  itemId,
  accessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  itemId: string;
  accessToken: string;
  timeoutMs?: number;
}): Promise<MercadoLivreItemPromotionsResponse> {
  const normalizedItemId = itemId.trim();


  if (!normalizedItemId) {
    throw new Error(
      "Item Mercado Livre é obrigatório para consultar promoções.",
    );
  }


  if (!accessToken) {
    throw new Error(
      "Access token Mercado Livre é obrigatório para consultar promoções.",
    );
  }


  const controller = new AbortController();


  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);


  try {
    const url = new URL(
      `${MERCADO_LIVRE_URLS.api}/seller-promotions/items/${encodeURIComponent(
        normalizedItemId,
      )}`,
    );


    url.searchParams.set("app_version", "v2");


    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });


    if (!response.ok) {
      const body = await response.text();


      throw new Error(
        `Falha ao consultar promoções de ${normalizedItemId}. HTTP ${
          response.status
        }. ${body.slice(0, 300)}`,
      );
    }


    const payload: unknown = await response.json();


    if (isJsonObject(payload)) {
      return payload;
    }


    if (
      Array.isArray(payload) &&
      payload.every(isJsonObject)
    ) {
      return payload;
    }


    throw new Error(
      `Resposta inválida ao consultar promoções de ${normalizedItemId}.`,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "AbortError"
    ) {
      throw new Error(
        `REQUEST_TIMEOUT: consulta de promoções de ${normalizedItemId} excedeu ${timeoutMs}ms.`,
      );
    }


    throw error;
  } finally {
    clearTimeout(timeout);
  }
}


export type MercadoLivrePromotionDetailsResponse =
  Record<string, unknown>;

function readPromotionOfferStatus(
  value: unknown,
): string | null {
  if (typeof value === "string") return value.toLowerCase();
  if (isJsonObject(value)) {
    const id = readString(value.id);
    return id ? id.toLowerCase() : null;
  }
  return null;
}

export async function getMercadoLivrePromotionOffer({
  offerId,
  accessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  offerId: string;
  accessToken: string;
  timeoutMs?: number;
}): Promise<{
  raw: Record<string, unknown>;
  normalized: MercadoLivreNormalizedPromotionOffer;
}> {
  const normalizedOfferId = offerId.trim();
  if (!normalizedOfferId) throw new Error("Offer ID Mercado Livre é obrigatório.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(`${MERCADO_LIVRE_URLS.api}/seller-promotions/offers/${encodeURIComponent(normalizedOfferId)}`);
    url.searchParams.set("app_version", "v2");
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Falha ao consultar offer ${normalizedOfferId}. HTTP ${response.status}. ${body.slice(0, 300)}`);
    }
    const payload: unknown = await response.json();
    if (!isJsonObject(payload)) throw new Error(`Resposta inválida para offer ${normalizedOfferId}.`);
    return {
      raw: payload,
      normalized: {
        id: readString(payload.id),
        itemId: readString(payload.item_id),
        promotionId: readString(payload.promotion_id),
        type: readString(payload.type),
        status: readPromotionOfferStatus(payload.status),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}


export async function getMercadoLivrePromotionDetails({
  promotionId,
  promotionType,
  accessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  promotionId: string;
  promotionType: string;
  accessToken: string;
  timeoutMs?: number;
}): Promise<MercadoLivrePromotionDetailsResponse> {
  const normalizedPromotionId =
    promotionId.trim();


  const normalizedPromotionType =
    promotionType.trim();


  if (!normalizedPromotionId) {
    throw new Error(
      "Promoção Mercado Livre é obrigatória para consultar detalhes.",
    );
  }


  if (!normalizedPromotionType) {
    throw new Error(
      "Tipo da promoção Mercado Livre é obrigatório para consultar detalhes.",
    );
  }


  if (!accessToken) {
    throw new Error(
      "Access token Mercado Livre é obrigatório para consultar a promoção.",
    );
  }


  const controller =
    new AbortController();


  const timeout =
    setTimeout(() => {
      controller.abort();
    }, timeoutMs);


  try {
    const url = new URL(
      `${MERCADO_LIVRE_URLS.api}/seller-promotions/promotions/${encodeURIComponent(
        normalizedPromotionId,
      )}`,
    );


    url.searchParams.set(
      "promotion_type",
      normalizedPromotionType,
    );


    url.searchParams.set(
      "app_version",
      "v2",
    );


    const response =
      await fetch(
        url,
        {
          method: "GET",


          headers: {
            Authorization:
              `Bearer ${accessToken}`,


            Accept:
              "application/json",
          },


          cache: "no-store",


          signal:
            controller.signal,
        },
      );


    if (!response.ok) {
      const body =
        await response.text();


      throw new Error(
        `Falha ao consultar detalhes da promoção ${normalizedPromotionId}. HTTP ${
          response.status
        }. ${body.slice(0, 300)}`,
      );
    }


    const payload: unknown =
      await response.json();


    if (!isJsonObject(payload)) {
      throw new Error(
        `Resposta inválida ao consultar detalhes da promoção ${normalizedPromotionId}.`,
      );
    }


    return payload;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "AbortError"
    ) {
      throw new Error(
        `REQUEST_TIMEOUT: consulta da promoção ${normalizedPromotionId} excedeu ${timeoutMs}ms.`,
      );
    }


    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
