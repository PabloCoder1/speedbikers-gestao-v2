import "server-only";

import { getProductStockIntelligence } from "@/features/stock/get-product-stock-intelligence";
import { createAdminClient } from "@/lib/supabase/admin";

type AlertCandidate = {
  alertType: string;
  severity: "critical" | "warning" | "info";
  dedupeKey: string;
  evidence: Record<string, unknown>;
  suggestedActionCode?: string | null;
};

function numeric(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function evaluateProductOperationalAlerts(productId: string) {
  const intelligence = await getProductStockIntelligence(productId);
  if (!intelligence) return { found: false, alerts: 0 } as const;
  const alerts: AlertCandidate[] = [];
  const add = (
    alertType: string,
    severity: AlertCandidate["severity"],
    evidence: Record<string, unknown>,
    suggestedActionCode: string | null = null,
    dedupeScope: string | null = null,
  ) => {
    const suffix = dedupeScope ? `:${dedupeScope}` : "";
    alerts.push({ alertType, severity, dedupeKey: `product:${productId}:${alertType}${suffix}`, evidence, suggestedActionCode });
  };

  const physical = intelligence.physical;
  const physicalReady = physical.ready === true;
  const physicalAvailable = numeric(physical.available);
  const threshold = numeric(physical.lowStockThreshold);
  if (physicalReady && physicalAvailable === 0) {
    add("PHYSICAL_OUT_OF_STOCK", "critical", { sourceSku: intelligence.mapping.sourceSku, available: 0, checkedAt: physical.checkedAt }, "review_physical_replenishment");
  }
  if (physicalReady && physical.kind === "simple" && physicalAvailable !== null && threshold !== null && threshold > 0 && physicalAvailable < threshold) {
    add("PHYSICAL_LOW_STOCK", "warning", { sourceSku: intelligence.mapping.sourceSku, available: physicalAvailable, lowStockThreshold: threshold }, "review_physical_replenishment");
  }
  if (physical.kind === "kit" && physical.applicable === true && !physicalReady) {
    add("KIT_COMPONENT_STOCK_UNKNOWN", "warning", {
      sourceSku: intelligence.mapping.sourceSku,
      missingComponents: physical.missingComponents ?? [],
      conflict: physical.conflict ?? null,
    }, "review_kit_components");
  }
  if (intelligence.advertised.listingCount > 0 && intelligence.mapping.status === "missing") {
    add("STOCK_MAPPING_MISSING", "warning", { sku: intelligence.product.sku, listingCount: intelligence.advertised.listingCount }, "review_stock_mapping");
  }
  if (intelligence.mapping.status === "conflict") {
    add("STOCK_MAPPING_CONFLICT", "warning", { sku: intelligence.product.sku, candidates: intelligence.mapping.candidates }, "resolve_stock_mapping_conflict");
  }
  for (const account of intelligence.full.accounts) {
    if (account.inventoryCount > 0 && account.pendingInventoryCount === 0 && account.available === 0) {
      add(
        "FULL_OUT_OF_STOCK",
        "critical",
        {
          accountId: account.accountId,
          accountCode: account.code,
          accountName: account.displayName,
          inventoryCount: account.inventoryCount,
          available: 0,
          checkedAt: account.checkedAt,
        },
        "review_full_replenishment",
        `account:${account.accountId}`,
      );
    }
    if (account.notAvailable > 0) {
      add(
        "FULL_UNAVAILABLE_UNITS",
        "info",
        {
          accountId: account.accountId,
          accountCode: account.code,
          accountName: account.displayName,
          notAvailable: account.notAvailable,
          checkedAt: account.checkedAt,
        },
        "review_full_unavailable_units",
        `account:${account.accountId}`,
      );
    }
  }
  const activeZero = intelligence.advertised.offers.filter((offer) => offer.status === "active" && offer.available === 0);
  if (activeZero.length > 0) {
    add("ACTIVE_LISTING_NO_ADVERTISED_AVAILABILITY", "warning", { affectedOffers: activeZero.length, advertisedAvailability: 0 }, "review_advertised_availability");
  }
  if (physicalReady && physicalAvailable !== null) {
    const divergent = intelligence.advertised.offers.filter(
      (offer) => offer.status === "active" && !offer.inventoryId && offer.available !== null && offer.available > physicalAvailable,
    );
    if (divergent.length > 0) {
      add("ADVERTISED_ABOVE_PHYSICAL_AVAILABLE", "warning", {
        physicalAvailable,
        offers: divergent.map((offer) => ({ accountId: offer.accountId, advertisedAvailability: offer.available })),
      }, "review_advertised_vs_physical");
    }
  }

  const admin = createAdminClient();
  const { data: activeListings, error: listingsError } = await admin.from("ml_listings")
    .select("id,item_id").eq("organization_id", intelligence.product.organizationId)
    .eq("product_id", productId).eq("is_current", true).eq("status", "active");
  if (listingsError) throw new Error(`ALERT_PRICE_LISTINGS_FAILED:${listingsError.message}`);
  const listingIds = (activeListings ?? []).map((listing) => listing.id);
  const { data: priceStates, error: pricesError } = listingIds.length
    ? await admin.from("ml_offer_price_states")
        .select("ml_listing_id,base_price,effective_price,price_checked_at,promotion_resolution")
        .eq("offer_scope", "listing").in("ml_listing_id", listingIds)
    : { data: [], error: null };
  if (pricesError) throw new Error(`ALERT_PRICE_STATES_FAILED:${pricesError.message}`);
  const readyPrices = (priceStates ?? []).filter((state) =>
    numeric(state.base_price) !== null && numeric(state.effective_price) !== null && Boolean(state.price_checked_at),
  );
  const effectiveCents = readyPrices.map((state) => Math.round((numeric(state.effective_price) ?? 0) * 100));
  const baseCents = readyPrices.map((state) => Math.round((numeric(state.base_price) ?? 0) * 100));
  if (new Set(effectiveCents).size > 1) {
    add("FINAL_PRICE_DIVERGENCE", "info", {
      min: Math.min(...effectiveCents) / 100,
      max: Math.max(...effectiveCents) / 100,
      spread: (Math.max(...effectiveCents) - Math.min(...effectiveCents)) / 100,
      validatedListings: readyPrices.length,
    });
  }
  if (new Set(baseCents).size > 1) {
    add("BASE_PRICE_DIVERGENCE", "info", {
      min: Math.min(...baseCents) / 100,
      max: Math.max(...baseCents) / 100,
      spread: (Math.max(...baseCents) - Math.min(...baseCents)) / 100,
      validatedListings: readyPrices.length,
    });
  }
  if (listingIds.length > readyPrices.length) {
    add("PRICE_VALIDATION_PENDING", "info", { activeListings: listingIds.length, validatedListings: readyPrices.length, pendingListings: listingIds.length - readyPrices.length });
  }
  const uncertain = (priceStates ?? []).filter((state) => [
    "active_promotion_without_price",
    "ambiguous_multiple_active_prices",
    "sale_price_promotion_unmatched",
  ].includes(state.promotion_resolution));
  if (uncertain.length > 0) {
    add("PROMOTION_EXPLANATION_UNCERTAIN", "info", {
      listings: uncertain.map((state) => ({ listingId: state.ml_listing_id, resolution: state.promotion_resolution })),
    });
  }

  const { data: applied, error: applyError } = await admin.rpc("apply_product_operational_alerts", {
    target_organization_id: intelligence.product.organizationId,
    target_product_id: productId,
    current_alerts: alerts,
  });
  if (applyError) throw new Error(`ALERT_APPLY_FAILED:${applyError.message}`);
  return { found: true, alerts: applied ?? alerts.length, candidates: alerts } as const;
}
