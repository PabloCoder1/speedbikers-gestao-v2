import "server-only";

import {
  getMercadoLivreCatalogItems,
  getMercadoLivreItemPerformance,
  getMercadoLivrePriceSuggestion,
  getMercadoLivrePriceToWin,
} from "@/integrations/mercado-livre/diagnostics";
import { getValidMercadoLivreAccessToken } from "@/integrations/mercado-livre/access-token";
import {
  computeCompetitorStats,
  computeKnownContribution,
  filterOutOwnSellers,
  normalizeCompetitionStatus,
  type CompetitorStats,
  type ItemPerformanceRaw,
  type PriceSuggestionRaw,
  type PriceToWinRaw,
} from "@/features/product-diagnostics/product-market-evidence-domain";
import { createAdminClient } from "@/lib/supabase/admin";

const OFFICIAL_ML_CACHE_TTL_MS = 45 * 60 * 1000;

export type OfficialMarketData = {
  priceToWin: PriceToWinRaw[];
  competitorStatsByCatalogProduct: Record<string, CompetitorStats>;
  priceSuggestions: PriceSuggestionRaw[];
  performance: ItemPerformanceRaw[];
  knownContributionByItemId: Record<string, number | null>;
  catalogProductIdByItemId: Record<string, string | null>;
  referenceThumbnailsByCatalogProduct: Record<string, string[]>;
};

type ListingTarget = { mlAccountId: string; accountCode: string; itemId: string };

async function resolveListingTargets(organizationId: string, productId: string, allowedMlAccountIds: string[]): Promise<ListingTarget[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ml_listings")
    .select("ml_account_id,item_id,ml_accounts!inner(code)")
    .eq("organization_id", organizationId)
    .eq("product_id", productId)
    .eq("is_current", true)
    .in("ml_account_id", allowedMlAccountIds.length ? allowedMlAccountIds : ["00000000-0000-0000-0000-000000000000"]);
  if (error) throw new Error(`PRODUCT_DIAGNOSTIC_LISTING_TARGETS_FAILED:${error.message}`);
  return (data ?? []).map((row) => {
    const account = Array.isArray(row.ml_accounts) ? row.ml_accounts[0] : row.ml_accounts;
    return { mlAccountId: row.ml_account_id as string, accountCode: (account as { code: string } | null)?.code ?? "unknown", itemId: row.item_id as string };
  });
}

async function readCache(organizationId: string, productId: string): Promise<OfficialMarketData | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("product_market_research_runs")
    .select("data,expires_at")
    .eq("organization_id", organizationId)
    .eq("product_id", productId)
    .eq("kind", "official_ml")
    .eq("status", "succeeded")
    .gt("expires_at", new Date().toISOString())
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`PRODUCT_DIAGNOSTIC_MARKET_CACHE_READ_FAILED:${error.message}`);
  return (data?.data as OfficialMarketData | undefined) ?? null;
}

async function writeCache(organizationId: string, productId: string, outcome: { status: "succeeded"; data: OfficialMarketData } | { status: "failed"; errorCode: string; errorMessage: string }) {
  const admin = createAdminClient();
  const expiresAt = new Date(Date.now() + OFFICIAL_ML_CACHE_TTL_MS).toISOString();
  await admin.from("product_market_research_runs").insert(
    outcome.status === "succeeded"
      ? { organization_id: organizationId, product_id: productId, kind: "official_ml", status: "succeeded", data: outcome.data, expires_at: expiresAt }
      : { organization_id: organizationId, product_id: productId, kind: "official_ml", status: "failed", data: {}, error_code: outcome.errorCode, error_message: outcome.errorMessage, expires_at: expiresAt },
  );
}

/**
 * Fetches price_to_win, catalog competitors, price suggestions and item
 * performance for every current listing of a product, across all
 * connected accounts. Cached for 45 minutes (product_market_research_runs,
 * kind='official_ml') so repeated clicks don't re-hit the ML API. A single
 * listing's failure is skipped, not fatal to the whole product — partial
 * market data is still useful evidence.
 */
export async function fetchOfficialMarketData(params: {
  organizationId: string;
  productId: string;
  allowedMlAccountIds: string[];
  averageCost: number | null;
  forceRefresh: boolean;
}): Promise<OfficialMarketData | null> {
  const targets = await resolveListingTargets(params.organizationId, params.productId, params.allowedMlAccountIds);
  if (targets.length === 0) return null;

  if (!params.forceRefresh) {
    const cached = await readCache(params.organizationId, params.productId);
    if (cached) return cached;
  }

  const priceToWin: PriceToWinRaw[] = [];
  const priceSuggestions: PriceSuggestionRaw[] = [];
  const performance: ItemPerformanceRaw[] = [];
  const knownContributionByItemId: Record<string, number | null> = {};
  const catalogProductIdByItemId: Record<string, string | null> = {};
  const fetchedAt = new Date().toISOString();

  // Fetched across all targets (accounts) in parallel, not sequentially —
  // sequential fetching across up to 4 accounts x 3 calls each was slow
  // enough to blow past the worker's maxDuration (observed stuck in
  // 'evidence' phase for minutes in production before this fix).
  await Promise.all(
    targets.map(async (target) => {
      try {
        const token = await getValidMercadoLivreAccessToken(target.mlAccountId);
        const [priceToWinResult, suggestionResult, performanceResult] = await Promise.allSettled([
          getMercadoLivrePriceToWin({ itemId: target.itemId, accessToken: token.accessToken }),
          getMercadoLivrePriceSuggestion({ itemId: target.itemId, accessToken: token.accessToken }),
          getMercadoLivreItemPerformance({ itemId: target.itemId, accessToken: token.accessToken }),
        ]);

        if (priceToWinResult.status === "fulfilled") {
          const raw = priceToWinResult.value;
          catalogProductIdByItemId[target.itemId] = raw.catalogProductId;
          priceToWin.push({
            itemId: raw.itemId, accountCode: target.accountCode, currentPrice: raw.currentPrice, currencyId: raw.currencyId,
            priceToWin: raw.priceToWin, status: normalizeCompetitionStatus(raw.status), catalogProductId: raw.catalogProductId,
            winnerPrice: raw.winnerPrice, boosts: raw.boosts, visitShare: raw.visitShare,
            competitorsSharingFirstPlace: raw.competitorsSharingFirstPlace, reason: raw.reason, fetchedAt,
          });
        }

        if (suggestionResult.status === "fulfilled") {
          const raw = suggestionResult.value;
          const contribution = computeKnownContribution({
            suggestedPrice: raw.suggestedPriceAmount, averageCost: params.averageCost, sellingFees: raw.sellingFees, shippingFees: raw.shippingFees,
          });
          knownContributionByItemId[target.itemId] = contribution;
          priceSuggestions.push({
            itemId: raw.itemId, accountCode: target.accountCode, status: raw.status, currentPriceAmount: raw.currentPriceAmount,
            suggestedPriceAmount: raw.suggestedPriceAmount, lowestPriceAmount: raw.lowestPriceAmount, internalPriceAmount: raw.internalPriceAmount,
            percentDifference: raw.percentDifference, applicableSuggestion: raw.applicableSuggestion, sellingFees: raw.sellingFees,
            shippingFees: raw.shippingFees, lastUpdated: raw.lastUpdated, fetchedAt,
          });
        }

        if (performanceResult.status === "fulfilled") {
          const raw = performanceResult.value;
          performance.push({ itemId: raw.itemId, accountCode: target.accountCode, score: raw.score, level: raw.level, levelWording: raw.levelWording, pendingBuckets: raw.pendingBuckets, fetchedAt });
        }
      } catch (error) {
        console.error(JSON.stringify({ event: "product_diagnostic_market_fetch_failed", itemId: target.itemId, error: error instanceof Error ? error.message.slice(0, 300) : "unknown" }));
      }
    }),
  );

  const uniqueOwnSellerIdsQuery = await createAdminClient().from("ml_accounts").select("seller_id").eq("organization_id", params.organizationId);
  const ownSellerIds = (uniqueOwnSellerIdsQuery.data ?? []).map((row) => row.seller_id).filter((value): value is string => Boolean(value));

  const uniqueCatalogProductIds = [...new Set(Object.values(catalogProductIdByItemId).filter((value): value is string => Boolean(value)))];
  const competitorStatsByCatalogProduct: Record<string, CompetitorStats> = {};
  const referenceThumbnailsByCatalogProduct: Record<string, string[]> = {};
  await Promise.all(
    uniqueCatalogProductIds.map(async (catalogProductId) => {
      try {
        const token = await getValidMercadoLivreAccessToken(targets[0].mlAccountId);
        const offers = await getMercadoLivreCatalogItems({ catalogProductId, accessToken: token.accessToken });
        const competitorOffers = filterOutOwnSellers(offers, ownSellerIds);
        const ourPricesForCatalog = priceToWin.filter((entry) => entry.catalogProductId === catalogProductId).map((entry) => entry.currentPrice).filter((value): value is number => value !== null);
        const ourLowest = ourPricesForCatalog.length ? Math.min(...ourPricesForCatalog) : null;
        competitorStatsByCatalogProduct[catalogProductId] = computeCompetitorStats(ourLowest, competitorOffers.map((offer) => offer.price));
        referenceThumbnailsByCatalogProduct[catalogProductId] = competitorOffers.map((offer) => offer.thumbnail).filter((value): value is string => Boolean(value)).slice(0, 3);
      } catch (error) {
        console.error(JSON.stringify({ event: "product_diagnostic_catalog_items_failed", catalogProductId, error: error instanceof Error ? error.message.slice(0, 300) : "unknown" }));
      }
    }),
  );

  const result: OfficialMarketData = { priceToWin, competitorStatsByCatalogProduct, priceSuggestions, performance, knownContributionByItemId, catalogProductIdByItemId, referenceThumbnailsByCatalogProduct };
  await writeCache(params.organizationId, params.productId, { status: "succeeded", data: result });
  return result;
}
