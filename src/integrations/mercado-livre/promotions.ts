import "server-only";

import { MERCADO_LIVRE_URLS } from "./constants";


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
  status: string | null;
  price: number | null;
  startDate: string | null;
  finishDate: string | null;
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
    | "active_promotion";
  activePromotion:
    | MercadoLivreNormalizedPromotion
    | null;
  activePromotionCount: number;
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


function normalizePromotion(
  promotion: Record<string, unknown>,
): MercadoLivreNormalizedPromotion {
  return {
    id: readString(promotion.id),
    type: readString(promotion.type),
    status: readString(promotion.status),
    price: getPromotionPrice(promotion),
    startDate:
      readString(promotion.start_date),
    finishDate:
      readString(promotion.finish_date),
  };
}


export function resolveMercadoLivrePromotionState({
  basePrice,
  payload,
}: {
  basePrice: number | null;
  payload: MercadoLivreItemPromotionsResponse;
}): MercadoLivreResolvedPromotionState {
  const rawPromotions = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.results)
      ? payload.results.filter(isJsonObject)
      : [payload];


  const startedPromotions = rawPromotions
    .map(normalizePromotion)
    .filter(
      (promotion) =>
        promotion.status === "started",
    );


  if (startedPromotions.length === 0) {
    return {
      basePrice,
      effectivePrice: basePrice,
      discountPercent: null,
      hasActivePromotion: false,
      resolution: "no_active_promotion",
      activePromotion: null,
      activePromotionCount: 0,
    };
  }


  const promotionsWithPrice =
    startedPromotions.filter(
      (promotion): promotion is MercadoLivreNormalizedPromotion & {
        price: number;
      } => promotion.price !== null,
    );


  if (promotionsWithPrice.length === 0) {
    return {
      basePrice,
      effectivePrice: null,
      discountPercent: null,
      hasActivePromotion: true,
      resolution: "active_promotion_without_price",
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
            promotion.price,
        ),
      ),
    );


  if (uniquePrices.length > 1) {
    return {
      basePrice,
      effectivePrice: null,
      discountPercent: null,
      hasActivePromotion: true,
      resolution:
        "ambiguous_multiple_active_prices",
      activePromotion: null,
      activePromotionCount:
        startedPromotions.length,
    };
  }


  const activePromotion =
    promotionsWithPrice[0];


  const effectivePrice =
    activePromotion.price;


  const discountPercent =
    basePrice !== null &&
    basePrice > 0 &&
    effectivePrice < basePrice
      ? Math.round(
          (((basePrice - effectivePrice) /
            basePrice) *
            100) *
            100,
        ) / 100
      : null;


  return {
    basePrice,
    effectivePrice,
    discountPercent,
    hasActivePromotion: true,
    resolution: "active_promotion",
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
