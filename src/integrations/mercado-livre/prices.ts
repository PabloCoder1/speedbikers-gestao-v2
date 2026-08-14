import "server-only";

import { MERCADO_LIVRE_URLS } from "./constants";
import type { MercadoLivreNormalizedSalePrice } from "./items";

const DEFAULT_TIMEOUT_MS = 15_000;

export type MercadoLivreItemPricesResponse = Record<string, unknown>;
export type MercadoLivreStandardPriceResolution =
  | "resolved"
  | "multiple_same_amount"
  | "ambiguous"
  | "not_found";

export type MercadoLivreNormalizedStandardPrice = {
  resolution: MercadoLivreStandardPriceResolution;
  priceId: string | null;
  amount: number | null;
  currencyId: string | null;
  lastUpdated: string | null;
  contextRestrictions: string[];
  candidateCount: number;
};

export type MercadoLivreBasePriceDecision = {
  basePrice: number | null;
  source:
    | "prices_standard"
    | "sale_price_regular_fallback"
    | "sale_price_amount_fallback"
    | "legacy_listing_fallback"
    | "unresolved";
  standardPrice: MercadoLivreNormalizedStandardPrice;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function dateMilliseconds(value: unknown) {
  const date = readString(value);
  if (!date) return null;
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function getMercadoLivreItemPrices({
  itemId,
  accessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  itemId: string;
  accessToken: string;
  timeoutMs?: number;
}): Promise<MercadoLivreItemPricesResponse> {
  const normalizedItemId = itemId.trim();
  if (!normalizedItemId) throw new Error("Item Mercado Livre é obrigatório para consultar prices.");
  if (!accessToken) throw new Error("Access token Mercado Livre é obrigatório para consultar prices.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${MERCADO_LIVRE_URLS.api}/items/${encodeURIComponent(normalizedItemId)}/prices`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Falha ao consultar prices de ${normalizedItemId}. HTTP ${response.status}. ${body.slice(0, 300)}`);
    }
    const payload: unknown = await response.json();
    if (!isObject(payload)) throw new Error(`Resposta inválida de prices para ${normalizedItemId}.`);
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`REQUEST_TIMEOUT: prices de ${normalizedItemId} excedeu ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeMercadoLivreStandardPrice({
  payload,
  referenceAt,
}: {
  payload: MercadoLivreItemPricesResponse;
  referenceAt: string | null;
}): MercadoLivreNormalizedStandardPrice {
  const prices = Array.isArray(payload.prices) ? payload.prices.filter(isObject) : [];
  const referenceMs = referenceAt ? Date.parse(referenceAt) : Date.now();
  const validReferenceMs = Number.isFinite(referenceMs) ? referenceMs : Date.now();
  const candidates = prices.map((price) => {
    if (readString(price.type) !== "standard") return null;
    const amount = readNumber(price.amount);
    if (amount === null || amount <= 0) return null;
    const conditions = isObject(price.conditions) ? price.conditions : {};
    if (readBoolean(conditions.eligible) === false) return null;
    const minPurchaseUnit = readNumber(conditions.min_purchase_unit);
    if (minPurchaseUnit !== null && minPurchaseUnit > 1) return null;
    const contextRestrictions = Array.isArray(conditions.context_restrictions)
      ? conditions.context_restrictions.filter((value): value is string => typeof value === "string")
      : [];
    if (contextRestrictions.some((restriction) => restriction !== "channel_marketplace")) return null;
    const startMs = dateMilliseconds(conditions.start_time);
    const endMs = dateMilliseconds(conditions.end_time);
    if (startMs !== null && validReferenceMs < startMs) return null;
    if (endMs !== null && validReferenceMs > endMs) return null;
    return {
      priceId: readString(price.id), amount, currencyId: readString(price.currency_id),
      lastUpdated: readString(price.last_updated), contextRestrictions,
      priority: contextRestrictions.includes("channel_marketplace") ? 2 : 1,
    };
  }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

  const empty = (resolution: "not_found" | "ambiguous", count: number): MercadoLivreNormalizedStandardPrice => ({
    resolution, priceId: null, amount: null, currencyId: null, lastUpdated: null,
    contextRestrictions: [], candidateCount: count,
  });
  if (candidates.length === 0) return empty("not_found", 0);
  const maximumPriority = Math.max(...candidates.map((candidate) => candidate.priority));
  const preferred = candidates.filter((candidate) => candidate.priority === maximumPriority);
  const amounts = new Set(preferred.map((candidate) => Math.round(candidate.amount * 100)));
  if (amounts.size > 1) return empty("ambiguous", preferred.length);
  preferred.sort((left, right) => (Date.parse(right.lastUpdated ?? "") || 0) - (Date.parse(left.lastUpdated ?? "") || 0));
  const winner = preferred[0];
  return {
    resolution: preferred.length > 1 ? "multiple_same_amount" : "resolved",
    priceId: winner.priceId, amount: winner.amount, currencyId: winner.currencyId,
    lastUpdated: winner.lastUpdated, contextRestrictions: winner.contextRestrictions,
    candidateCount: preferred.length,
  };
}

export function resolveMercadoLivreBasePrice({ standardPrice, salePrice, legacyListingPrice }: {
  standardPrice: MercadoLivreNormalizedStandardPrice;
  salePrice: MercadoLivreNormalizedSalePrice;
  legacyListingPrice: number | null;
}): MercadoLivreBasePriceDecision {
  if (standardPrice.amount !== null && standardPrice.amount > 0) return { basePrice: standardPrice.amount, source: "prices_standard", standardPrice };
  if (salePrice.regularAmount !== null && salePrice.regularAmount > 0) return { basePrice: salePrice.regularAmount, source: "sale_price_regular_fallback", standardPrice };
  const saleShowsPromotion = Boolean(salePrice.campaignId || salePrice.promotionId ||
    (salePrice.regularAmount !== null && salePrice.amount !== null && salePrice.amount < salePrice.regularAmount));
  if (!saleShowsPromotion && salePrice.amount !== null && salePrice.amount > 0) return { basePrice: salePrice.amount, source: "sale_price_amount_fallback", standardPrice };
  if (legacyListingPrice !== null && legacyListingPrice > 0) return { basePrice: legacyListingPrice, source: "legacy_listing_fallback", standardPrice };
  return { basePrice: null, source: "unresolved", standardPrice };
}
