import "server-only";

import { getMercadoLivreItemSalePrice, normalizeMercadoLivreSalePrice } from "@/integrations/mercado-livre/items";
import {
  getMercadoLivreItemPromotions,
  getMercadoLivrePromotionDetails,
  getMercadoLivrePromotionOffer,
  normalizeMercadoLivreItemPromotions,
  resolveMercadoLivrePromotionState,
  type MercadoLivreNormalizedPromotionOffer,
} from "@/integrations/mercado-livre/promotions";
import {
  getMercadoLivreItemPrices,
  normalizeMercadoLivreStandardPrice,
  resolveMercadoLivreBasePrice,
} from "@/integrations/mercado-livre/prices";

export async function resolveListingPriceState({ itemId, legacyListingPrice, accessToken }: {
  itemId: string;
  legacyListingPrice: number | null;
  accessToken: string;
}) {
  const [pricesPayload, salePricePayload, promotionsPayload] = await Promise.all([
    getMercadoLivreItemPrices({ itemId, accessToken }),
    getMercadoLivreItemSalePrice({ itemId, accessToken }),
    getMercadoLivreItemPromotions({ itemId, accessToken }),
  ]);
  const normalizedSalePrice = normalizeMercadoLivreSalePrice(salePricePayload);
  const standardPrice = normalizeMercadoLivreStandardPrice({
    payload: pricesPayload,
    referenceAt: normalizedSalePrice.referenceDate,
  });
  const basePriceDecision = resolveMercadoLivreBasePrice({ standardPrice, salePrice: normalizedSalePrice, legacyListingPrice });
  const normalizedPromotions = normalizeMercadoLivreItemPromotions(promotionsPayload);

  let winningOffer: MercadoLivreNormalizedPromotionOffer | null = null;
  let winningOfferPayload: Record<string, unknown> | null = null;
  let winningOfferError: string | null = null;
  let resolved = resolveMercadoLivrePromotionState({
    basePrice: basePriceDecision.basePrice,
    payload: promotionsPayload,
    salePrice: normalizedSalePrice,
  });

  if (!resolved.activePromotion && normalizedSalePrice.promotionId?.startsWith("OFFER-")) {
    try {
      const offer = await getMercadoLivrePromotionOffer({ offerId: normalizedSalePrice.promotionId, accessToken });
      winningOffer = offer.normalized;
      winningOfferPayload = offer.raw;
      resolved = resolveMercadoLivrePromotionState({
        basePrice: basePriceDecision.basePrice,
        payload: promotionsPayload,
        salePrice: normalizedSalePrice,
        winningOffer,
      });
    } catch (error) {
      winningOfferError = error instanceof Error ? error.message.slice(0, 500) : "Erro desconhecido";
    }
  }

  let activePromotionDetails: Record<string, unknown> | null = null;
  let promotionDetailsError: string | null = null;
  try {
    if (resolved.activePromotion?.id && resolved.activePromotion.type) {
      activePromotionDetails = await getMercadoLivrePromotionDetails({
        promotionId: resolved.activePromotion.id,
        promotionType: resolved.activePromotion.type,
        accessToken,
      });
    }
  } catch (error) {
    promotionDetailsError = error instanceof Error ? error.message.slice(0, 500) : "Erro desconhecido";
  }

  return {
    pricesPayload, standardPrice, basePriceDecision,
    salePricePayload, normalizedSalePrice,
    promotionsPayload, normalizedPromotions,
    winningOffer, winningOfferPayload, winningOfferError,
    resolved, activePromotionDetails, promotionDetailsError,
  };
}

export type ResolvedListingPriceState = Awaited<ReturnType<typeof resolveListingPriceState>>;
