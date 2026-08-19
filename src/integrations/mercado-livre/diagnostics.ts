import "server-only";

import { MERCADO_LIVRE_URLS } from "@/integrations/mercado-livre/constants";

const DEFAULT_TIMEOUT_MS = 15_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function readNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function readStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export class MercadoLivreDiagnosticsRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly responseCode: string | null,
    public readonly responseMessage: string | null,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MercadoLivreDiagnosticsRequestError";
  }
}

async function mercadoLivreGet({ path, accessToken, timeoutMs }: { path: string; accessToken: string; timeoutMs: number }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${MERCADO_LIVRE_URLS.api}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await response.text();
    let payload: unknown = null;
    try { payload = body ? JSON.parse(body) : null; } catch { payload = null; }
    if (!response.ok) {
      const errorPayload = isObject(payload) ? payload : {};
      const responseCode = readString(errorPayload.error) ?? readString(errorPayload.code);
      const responseMessage = readString(errorPayload.message) ?? (body.slice(0, 300) || null);
      throw new MercadoLivreDiagnosticsRequestError(
        `DIAGNOSTICS_HTTP_${response.status}:${responseCode ?? "unknown"}`,
        response.status,
        responseCode,
        responseMessage,
        response.status === 429 || response.status >= 500,
      );
    }
    if (!isObject(payload) && !Array.isArray(payload)) {
      throw new MercadoLivreDiagnosticsRequestError("DIAGNOSTICS_INVALID_RESPONSE", response.status, null, null, false);
    }
    return payload;
  } catch (error) {
    if (error instanceof MercadoLivreDiagnosticsRequestError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new MercadoLivreDiagnosticsRequestError("DIAGNOSTICS_TIMEOUT", null, "timeout", error.message, true);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export type PriceToWinResponse = {
  itemId: string;
  currentPrice: number | null;
  currencyId: string | null;
  priceToWin: number | null;
  status: string;
  catalogProductId: string | null;
  winnerPrice: number | null;
  boosts: string[];
  visitShare: number | null;
  competitorsSharingFirstPlace: number | null;
  reason: string | null;
};

/** GET /items/{ITEM_ID}/price_to_win?version=v2 */
export async function getMercadoLivrePriceToWin({
  itemId,
  accessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  itemId: string;
  accessToken: string;
  timeoutMs?: number;
}): Promise<PriceToWinResponse> {
  const raw = (await mercadoLivreGet({ path: `/items/${encodeURIComponent(itemId)}/price_to_win?version=v2`, accessToken, timeoutMs })) as Record<string, unknown>;
  const winner = isObject(raw.winner) ? raw.winner : null;
  return {
    itemId: readString(raw.item_id) ?? itemId,
    currentPrice: readNumber(raw.current_price),
    currencyId: readString(raw.currency_id),
    priceToWin: readNumber(raw.price_to_win),
    status: readString(raw.status) ?? "unknown",
    catalogProductId: readString(raw.catalog_product_id),
    winnerPrice: winner ? readNumber(winner.price) : null,
    boosts: readStringArray(raw.boosts),
    visitShare: readNumber(raw.visit_share),
    competitorsSharingFirstPlace: readNumber(raw.competitors_sharing_first_place),
    reason: readString(raw.reason),
  };
}

export type CatalogItemOffer = { itemId: string; sellerId: string; price: number; thumbnail: string | null };

/** GET /products/{PRODUCT_ID}/items — every seller offering the same catalog product, including us. */
export async function getMercadoLivreCatalogItems({
  catalogProductId,
  accessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  catalogProductId: string;
  accessToken: string;
  timeoutMs?: number;
}): Promise<CatalogItemOffer[]> {
  const raw = (await mercadoLivreGet({ path: `/products/${encodeURIComponent(catalogProductId)}/items`, accessToken, timeoutMs })) as Record<string, unknown>;
  const results = Array.isArray(raw.results) ? raw.results : [];
  const offers: CatalogItemOffer[] = [];
  for (const entry of results) {
    if (!isObject(entry)) continue;
    const itemId = readString(entry.item_id) ?? readString(entry.id);
    const sellerId = readString(entry.seller_id) ?? (isObject(entry.seller) ? readString(entry.seller.id) : null);
    const price = readNumber(entry.price) ?? (isObject(entry.sale_price) ? readNumber(entry.sale_price.amount) : null);
    const thumbnail = readString(entry.thumbnail);
    if (itemId && sellerId && price !== null) offers.push({ itemId, sellerId, price, thumbnail });
  }
  return offers;
}

export type PriceSuggestionResponse = {
  itemId: string;
  status: string;
  currentPriceAmount: number | null;
  suggestedPriceAmount: number | null;
  lowestPriceAmount: number | null;
  internalPriceAmount: number | null;
  percentDifference: number | null;
  applicableSuggestion: boolean;
  sellingFees: number | null;
  shippingFees: number | null;
  lastUpdated: string | null;
};

/** GET /suggestions/items/{ITEM_ID}/details */
export async function getMercadoLivrePriceSuggestion({
  itemId,
  accessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  itemId: string;
  accessToken: string;
  timeoutMs?: number;
}): Promise<PriceSuggestionResponse> {
  const raw = (await mercadoLivreGet({ path: `/suggestions/items/${encodeURIComponent(itemId)}/details`, accessToken, timeoutMs })) as Record<string, unknown>;
  const currentPrice = isObject(raw.current_price) ? raw.current_price : null;
  const suggestedPrice = isObject(raw.suggested_price) ? raw.suggested_price : null;
  const lowestPrice = isObject(raw.lowest_price) ? raw.lowest_price : null;
  const internalPrice = isObject(raw.internal_price) ? raw.internal_price : null;
  const costs = isObject(raw.costs) ? raw.costs : null;
  return {
    itemId: readString(raw.item_id) ?? itemId,
    status: readString(raw.status) ?? "unknown",
    currentPriceAmount: currentPrice ? readNumber(currentPrice.amount) : null,
    suggestedPriceAmount: suggestedPrice ? readNumber(suggestedPrice.amount) : null,
    lowestPriceAmount: lowestPrice ? readNumber(lowestPrice.amount) : null,
    internalPriceAmount: internalPrice ? readNumber(internalPrice.amount) : null,
    percentDifference: readNumber(raw.percent_difference),
    applicableSuggestion: readBoolean(raw.applicable_suggestion) ?? false,
    sellingFees: costs ? readNumber(costs.selling_fees) : null,
    shippingFees: costs ? readNumber(costs.shipping_fees) : null,
    lastUpdated: readString(raw.last_updated),
  };
}

export type ItemPerformanceResponse = {
  itemId: string;
  score: number | null;
  level: string | null;
  levelWording: string | null;
  pendingBuckets: string[];
};

/** GET /item/{ITEM_ID}/performance */
export async function getMercadoLivreItemPerformance({
  itemId,
  accessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  itemId: string;
  accessToken: string;
  timeoutMs?: number;
}): Promise<ItemPerformanceResponse> {
  const raw = (await mercadoLivreGet({ path: `/item/${encodeURIComponent(itemId)}/performance`, accessToken, timeoutMs })) as Record<string, unknown>;
  const buckets = Array.isArray(raw.buckets) ? raw.buckets : [];
  const pendingBuckets: string[] = [];
  for (const bucket of buckets) {
    if (!isObject(bucket)) continue;
    const status = readString(bucket.status);
    const code = readString(bucket.code) ?? readString(bucket.id);
    if (code && status && status.toLowerCase() === "pending") pendingBuckets.push(code);
  }
  return {
    itemId: readString(raw.item_id) ?? itemId,
    score: readNumber(raw.score),
    level: readString(raw.level),
    levelWording: readString(raw.level_wording),
    pendingBuckets,
  };
}
