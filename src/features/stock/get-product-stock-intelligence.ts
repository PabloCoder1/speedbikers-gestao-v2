import "server-only";

import {
  calculateCoverageDays,
  calculateKitAvailability,
  calculateThirtyDaySalesVelocity,
  purchaseLeadTimeDays,
} from "@/features/stock/stock-domain";
import { saoPauloDateKey, shiftSaoPauloDateKey } from "@/lib/date/sao-paulo";
import { createAdminClient } from "@/lib/supabase/admin";

type ReceiptAdjustmentRow = {
  sku_key: string;
  warehouse_key: string;
  quantity: number | string;
  applied_at: string;
};

function numberOrNull(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function weightedAverage(rows: { average_cost: unknown; current_quantity: unknown }[]) {
  if (rows.length === 0 || rows.some((row) => numberOrNull(row.average_cost) === null)) return null;
  const weights = rows.map((row) => numberOrNull(row.current_quantity) ?? 0);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight > 0) {
    return rows.reduce((sum, row, index) => sum + (numberOrNull(row.average_cost) ?? 0) * weights[index], 0) / totalWeight;
  }
  return rows.reduce((sum, row) => sum + (numberOrNull(row.average_cost) ?? 0), 0) / rows.length;
}

function latestIso(values: (string | null | undefined)[]) {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}


async function getReceiptAdjustments(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  skuKeys: string[],
) {
  if (skuKeys.length === 0) return [] as ReceiptAdjustmentRow[];
  const { data, error } = await admin
    .from("current_stock_receipt_adjustments")
    .select("sku_key,warehouse_key,quantity,applied_at")
    .eq("organization_id", organizationId)
    .in("sku_key", skuKeys)
    .returns<ReceiptAdjustmentRow[]>();
  if (error) {
    if (
      error.code === "42P01" ||
      error.code === "PGRST205" ||
      error.message.includes("current_stock_receipt_adjustments")
    ) {
      return [];
    }
    throw new Error(`STOCK_RECEIPT_ADJUSTMENTS_LOOKUP_FAILED:${error.message}`);
  }
  return data ?? [];
}

function applyReceiptAdjustments<
  T extends {
    sku_key: string;
    warehouse_key: string;
    available_quantity: unknown;
    current_quantity: unknown;
    checked_at: string;
  },
>(rows: T[], adjustments: ReceiptAdjustmentRow[]) {
  const quantityByTarget = new Map<string, number>();
  const datesByTarget = new Map<string, string[]>();
  for (const adjustment of adjustments) {
    const key = `${adjustment.sku_key}:${adjustment.warehouse_key}`;
    quantityByTarget.set(key, (quantityByTarget.get(key) ?? 0) + (numberOrNull(adjustment.quantity) ?? 0));
    const dates = datesByTarget.get(key);
    if (dates) dates.push(adjustment.applied_at);
    else datesByTarget.set(key, [adjustment.applied_at]);
  }

  return rows.map((row) => {
    const key = `${row.sku_key}:${row.warehouse_key}`;
    const adjustment = quantityByTarget.get(key) ?? 0;
    return {
      ...row,
      available_quantity: (numberOrNull(row.available_quantity) ?? 0) + adjustment,
      current_quantity: (numberOrNull(row.current_quantity) ?? 0) + adjustment,
      checked_at: latestIso([row.checked_at, ...(datesByTarget.get(key) ?? [])]) ?? row.checked_at,
    };
  });
}

export async function getProductStockIntelligence(
  productId: string,
  options: {
    organizationId?: string;
    allowedMlAccountIds?: string[];
  } = {},
) {
  const admin = createAdminClient();
  let productQuery = admin.from("products")
    .select("id,organization_id,sku,sku_key,name")
    .eq("id", productId);
  if (options.organizationId) {
    productQuery = productQuery.eq("organization_id", options.organizationId);
  }
  const { data: product, error: productError } = await productQuery.maybeSingle();
  if (productError) throw new Error(`STOCK_PRODUCT_LOOKUP_FAILED:${productError.message}`);
  if (!product) return null;

  const [
    { data: conflict, error: conflictError },
    { data: link, error: linkError },
    { data: unresolvedKit, error: unresolvedKitError },
  ] = await Promise.all([
    admin.from("product_inventory_link_conflicts").select("id,candidate_source_skus,evidence")
      .eq("organization_id", product.organization_id).eq("product_id", product.id).eq("source", "upseller").eq("is_current", true).maybeSingle(),
    admin.from("product_inventory_links").select("id,source_sku,source_sku_key,source_kind,link_method,confidence,evidence,source_import_id")
      .eq("organization_id", product.organization_id).eq("product_id", product.id).eq("source", "upseller").eq("is_active", true).maybeSingle(),
    admin.from("upseller_unresolved_kits").select("source_sku,source_sku_key,missing_component_sku_keys,reason")
      .eq("organization_id", product.organization_id).eq("source_sku_key", product.sku_key).eq("is_current", true).maybeSingle(),
  ]);
  if (conflictError || linkError || unresolvedKitError) throw new Error("STOCK_MAPPING_LOOKUP_FAILED");

  const mapping = conflict
    ? { status: "conflict" as const, sourceSku: null, sourceKind: null, method: null, candidates: conflict.candidate_source_skus }
    : link
      ? { status: "linked" as const, sourceSku: link.source_sku, sourceKind: link.source_kind as "simple" | "kit", method: link.link_method, candidates: null }
      : { status: "missing" as const, sourceSku: null, sourceKind: null, method: null, candidates: null };

  const kitDefinitionIssue = unresolvedKit ? {
    sourceSku: unresolvedKit.source_sku,
    sourceSkuKey: unresolvedKit.source_sku_key,
    missingComponentSkuKeys: unresolvedKit.missing_component_sku_keys,
    reason: unresolvedKit.reason,
  } : null;

  let physical: Record<string, unknown> = {
    applicable: Boolean(link) && !conflict,
    ready: false,
    kind: link?.source_kind ?? null,
    available: null,
    current: null,
    occupied: null,
    purchaseInTransit: null,
    transferInTransit: null,
    lowStockThreshold: null,
    averageCost: null,
    purchaseCost: null,
    effectiveCost: null,
    effectiveCostSource: null,
    warehouses: [],
    checkedAt: null,
  };
  let brand: string | null = null;

  if (link && !conflict) {
    const [{ data: catalog, error: catalogError }, { data: kitMetadata, error: kitMetadataError }] = await Promise.all([
      admin.from("upseller_product_catalog")
        .select("purchase_cost,retail_price,brand,barcodes")
        .eq("organization_id", product.organization_id).eq("sku_key", link.source_sku_key).maybeSingle(),
      link.source_kind === "kit"
        ? admin.from("upseller_kits").select("category")
            .eq("organization_id", product.organization_id).eq("kit_sku_key", link.source_sku_key).eq("is_current", true).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (catalogError || kitMetadataError) throw new Error("STOCK_CATALOG_LOOKUP_FAILED");
    brand = catalog?.brand ?? kitMetadata?.category ?? null;
    const purchaseCost = numberOrNull(catalog?.purchase_cost);
    if (link.source_kind === "simple") {
      const [{ data: states, error }, receiptAdjustments] = await Promise.all([
        admin.from("upseller_stock_states")
          .select("sku_key,warehouse_name,warehouse_key,shelf,low_stock_threshold,purchase_in_transit,transfer_in_transit,occupied_quantity,available_quantity,current_quantity,average_cost,stock_value,checked_at")
          .eq("organization_id", product.organization_id).eq("sku_key", link.source_sku_key)
          .order("warehouse_key"),
        getReceiptAdjustments(admin, product.organization_id, [link.source_sku_key]),
      ]);
      if (error) throw new Error("STOCK_STATES_LOOKUP_FAILED");
      const rows = applyReceiptAdjustments(states ?? [], receiptAdjustments);
      const averageCost = weightedAverage(rows);
      physical = {
        applicable: true,
        ready: rows.length > 0,
        kind: "simple",
        available: rows.length ? rows.reduce((sum, row) => sum + (numberOrNull(row.available_quantity) ?? 0), 0) : null,
        current: rows.length ? rows.reduce((sum, row) => sum + (numberOrNull(row.current_quantity) ?? 0), 0) : null,
        occupied: rows.length ? rows.reduce((sum, row) => sum + (numberOrNull(row.occupied_quantity) ?? 0), 0) : null,
        purchaseInTransit: rows.length ? rows.reduce((sum, row) => sum + (numberOrNull(row.purchase_in_transit) ?? 0), 0) : null,
        transferInTransit: rows.length ? rows.reduce((sum, row) => sum + (numberOrNull(row.transfer_in_transit) ?? 0), 0) : null,
        lowStockThreshold: rows.length ? rows.reduce((sum, row) => sum + (numberOrNull(row.low_stock_threshold) ?? 0), 0) : null,
        averageCost,
        purchaseCost,
        effectiveCost: averageCost ?? purchaseCost,
        effectiveCostSource: averageCost !== null ? "average_cost" : purchaseCost !== null ? "purchase_cost" : null,
        warehouses: rows.map((row) => ({
          name: row.warehouse_name, key: row.warehouse_key, shelf: row.shelf,
          available: numberOrNull(row.available_quantity), current: numberOrNull(row.current_quantity),
          occupied: numberOrNull(row.occupied_quantity), purchaseInTransit: numberOrNull(row.purchase_in_transit),
          transferInTransit: numberOrNull(row.transfer_in_transit), lowStockThreshold: numberOrNull(row.low_stock_threshold),
          averageCost: numberOrNull(row.average_cost), stockValue: numberOrNull(row.stock_value), checkedAt: row.checked_at,
        })),
        checkedAt: latestIso(rows.map((row) => row.checked_at)),
      };
    } else {
      const { data: components, error: componentsError } = await admin.from("upseller_kit_components")
        .select("component_sku,component_sku_key,required_quantity")
        .eq("organization_id", product.organization_id).eq("kit_sku_key", link.source_sku_key).eq("is_current", true);
      if (componentsError) throw new Error("KIT_COMPONENTS_LOOKUP_FAILED");
      const componentRows = components ?? [];
      const componentKeys = componentRows.map((row) => row.component_sku_key);
      const [{ data: nestedKits }, { data: states, error: statesError }, { data: catalogs }, receiptAdjustments] = await Promise.all([
        componentKeys.length
          ? admin.from("upseller_kits").select("kit_sku_key").eq("organization_id", product.organization_id).eq("is_current", true).in("kit_sku_key", componentKeys)
          : Promise.resolve({ data: [], error: null }),
        componentKeys.length
          ? admin.from("upseller_stock_states").select("sku_key,warehouse_name,warehouse_key,available_quantity,current_quantity,average_cost,checked_at")
            .eq("organization_id", product.organization_id).in("sku_key", componentKeys)
          : Promise.resolve({ data: [], error: null }),
        componentKeys.length
          ? admin.from("upseller_product_catalog").select("sku_key,purchase_cost").eq("organization_id", product.organization_id).in("sku_key", componentKeys)
          : Promise.resolve({ data: [], error: null }),
        getReceiptAdjustments(admin, product.organization_id, componentKeys),
      ]);
      if (statesError) throw new Error("KIT_STOCK_LOOKUP_FAILED");
      const stockRows = applyReceiptAdjustments(states ?? [], receiptAdjustments);
      const availability = nestedKits?.length
        ? { ready: false, available: null, warehouses: [], missingComponents: [], conflict: "nested_kit_unsupported" as const }
        : calculateKitAvailability(
            componentRows.map((row) => ({ skuKey: row.component_sku_key, requiredQuantity: row.required_quantity })),
            stockRows.map((row) => ({ skuKey: row.sku_key, warehouseKey: row.warehouse_key, availableQuantity: numberOrNull(row.available_quantity) ?? 0 })),
          );
      let kitCost = 0;
      let costReady = componentRows.length > 0;
      const componentCosts = componentRows.map((component) => {
        const componentStates = stockRows.filter((row) => row.sku_key === component.component_sku_key);
        const averageCost = weightedAverage(componentStates);
        const purchase = numberOrNull(catalogs?.find((row) => row.sku_key === component.component_sku_key)?.purchase_cost);
        const effective = averageCost ?? purchase;
        if (effective === null) costReady = false;
        else kitCost += effective * component.required_quantity;
        return { sku: component.component_sku, skuKey: component.component_sku_key, requiredQuantity: component.required_quantity, effectiveCost: effective };
      });
      const warehouseNameByKey = new Map(stockRows.map((row) => [row.warehouse_key, row.warehouse_name]));
      physical = {
        applicable: true,
        ready: availability.ready,
        kind: "kit",
        available: availability.available,
        current: null,
        occupied: null,
        purchaseInTransit: null,
        transferInTransit: null,
        lowStockThreshold: null,
        averageCost: null,
        purchaseCost: null,
        effectiveCost: costReady ? kitCost : null,
        effectiveCostSource: costReady ? "derived_components" : null,
        warehouses: availability.warehouses.map((warehouse) => ({ name: warehouseNameByKey.get(warehouse.warehouseKey) ?? warehouse.warehouseKey, key: warehouse.warehouseKey, available: warehouse.available })),
        checkedAt: latestIso(stockRows.map((row) => row.checked_at)),
        missingComponents: availability.missingComponents,
        conflict: availability.conflict,
        limitingComponents: componentCosts,
      };
    }
  }

  let listingTargetsQuery = admin.from("ml_listings")
    .select("id,ml_account_id,item_id,status,available_quantity,inventory_id")
    .eq("organization_id", product.organization_id).eq("product_id", product.id).eq("is_current", true);
  let variationTargetsQuery = admin.from("ml_listing_variations")
    .select("id,ml_account_id,ml_listing_id,variation_id,available_quantity,inventory_id,ml_listings!inner(item_id,status)")
    .eq("organization_id", product.organization_id).eq("product_id", product.id).eq("is_current", true);

  if (options.allowedMlAccountIds) {
    if (options.allowedMlAccountIds.length === 0) {
      listingTargetsQuery = listingTargetsQuery.in("ml_account_id", ["00000000-0000-0000-0000-000000000000"]);
      variationTargetsQuery = variationTargetsQuery.in("ml_account_id", ["00000000-0000-0000-0000-000000000000"]);
    } else {
      listingTargetsQuery = listingTargetsQuery.in("ml_account_id", options.allowedMlAccountIds);
      variationTargetsQuery = variationTargetsQuery.in("ml_account_id", options.allowedMlAccountIds);
    }
  }

  const [{ data: listingTargets, error: listingError }, { data: variationTargets, error: variationError }] = await Promise.all([
    listingTargetsQuery,
    variationTargetsQuery,
  ]);
  if (listingError || variationError) throw new Error("STOCK_ML_TARGETS_LOOKUP_FAILED");
  const advertisedOffers = [
    ...(listingTargets ?? []).map((row) => ({ accountId: row.ml_account_id, status: row.status, available: numberOrNull(row.available_quantity), inventoryId: row.inventory_id })),
    ...(variationTargets ?? []).map((row) => {
      const parent = Array.isArray(row.ml_listings) ? row.ml_listings[0] : row.ml_listings;
      return { accountId: row.ml_account_id, status: parent?.status ?? null, available: numberOrNull(row.available_quantity), inventoryId: row.inventory_id };
    }),
  ];
  const inventoryTargets = [...new Map(
    advertisedOffers.filter((offer) => typeof offer.inventoryId === "string" && offer.inventoryId)
      .map((offer) => [`${offer.accountId}:${offer.inventoryId}`, { accountId: offer.accountId, inventoryId: offer.inventoryId as string }]),
  ).values()];
  const accountIds = [...new Set(inventoryTargets.map((target) => target.accountId))];
  const inventoryIds = [...new Set(inventoryTargets.map((target) => target.inventoryId))];
  const [{ data: accountRows }, { data: fullRows, error: fullError }] = await Promise.all([
    accountIds.length ? admin.from("ml_accounts").select("id,code,display_name").in("id", accountIds) : Promise.resolve({ data: [], error: null }),
    inventoryIds.length ? admin.from("ml_fulfillment_stock_states")
      .select("ml_account_id,inventory_id,total_quantity,available_quantity,not_available_quantity,not_available_detail,checked_at")
      .eq("organization_id", product.organization_id).in("inventory_id", inventoryIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (fullError) throw new Error("FULFILLMENT_STATES_LOOKUP_FAILED");
  const targetKeys = new Set(inventoryTargets.map((target) => `${target.accountId}:${target.inventoryId}`));
  const relevantFullRows = (fullRows ?? []).filter((row) => targetKeys.has(`${row.ml_account_id}:${row.inventory_id}`));
  const notAvailableByStatus: Record<string, number> = {};
  for (const row of relevantFullRows) {
    if (!Array.isArray(row.not_available_detail)) continue;
    for (const detail of row.not_available_detail) {
      if (!detail || typeof detail !== "object") continue;
      const record = detail as Record<string, unknown>;
      const status = typeof record.status === "string" ? record.status : "unknown";
      notAvailableByStatus[status] = (notAvailableByStatus[status] ?? 0) + (numberOrNull(record.quantity) ?? 0);
    }
  }
  const baseAccounts = accountIds.map((accountId) => {
    const targets = inventoryTargets.filter((target) => target.accountId === accountId);
    const rows = relevantFullRows.filter((row) => row.ml_account_id === accountId);
    const account = accountRows?.find((row) => row.id === accountId);
    return {
      accountId, code: account?.code ?? null, displayName: account?.display_name ?? null,
      inventoryCount: targets.length, checkedInventoryCount: rows.length,
      pendingInventoryCount: targets.length - rows.length,
      available: rows.reduce((sum, row) => sum + (numberOrNull(row.available_quantity) ?? 0), 0),
      total: rows.reduce((sum, row) => sum + (numberOrNull(row.total_quantity) ?? 0), 0),
      notAvailable: rows.reduce((sum, row) => sum + (numberOrNull(row.not_available_quantity) ?? 0), 0),
      checkedAt: latestIso(rows.map((row) => row.checked_at)),
    };
  });

  const today = saoPauloDateKey();
  const periodFrom = shiftSaoPauloDateKey(today, -30);
  const periodTo = shiftSaoPauloDateKey(today, -1);
  const salesAccountIds = [...new Set(advertisedOffers.map((offer) => offer.accountId))];
  const [{ data: metricRows, error: metricError }, { data: coverageRuns, error: coverageError }] = salesAccountIds.length
    ? await Promise.all([
        admin.from("daily_product_metrics")
          .select("ml_account_id,metric_date,units_sold")
          .eq("organization_id", product.organization_id)
          .eq("product_id", product.id)
          .in("ml_account_id", salesAccountIds)
          .gte("metric_date", periodFrom)
          .lte("metric_date", periodTo),
        admin.from("sync_runs")
          .select("ml_account_id,metadata,finished_at")
          .eq("organization_id", product.organization_id)
          .eq("sync_type", "orders_dashboard_backfill")
          .eq("status", "succeeded")
          .in("ml_account_id", salesAccountIds)
          .order("finished_at", { ascending: false }),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  if (metricError || coverageError) throw new Error("STOCK_SALES_VELOCITY_LOOKUP_FAILED");
  const historyReady = salesAccountIds.length > 0 && salesAccountIds.every((accountId) =>
    (coverageRuns ?? []).some((run) => {
      if (run.ml_account_id !== accountId || !run.metadata || typeof run.metadata !== "object") return false;
      const coveredFrom = (run.metadata as Record<string, unknown>).covered_from;
      return typeof coveredFrom === "string" && coveredFrom <= periodFrom;
    }),
  );
  const velocity = calculateThirtyDaySalesVelocity({
    unitsSold30: (metricRows ?? []).reduce((sum, row) => sum + (numberOrNull(row.units_sold) ?? 0), 0),
    historyReady,
  });
  const physicalAvailable = numberOrNull(physical.available);
  const physicalCoverageDays = calculateCoverageDays(
    physicalAvailable,
    velocity.avgDailySales30,
    velocity.salesVelocityReady,
  );
  const fullAvailable = relevantFullRows.reduce((sum, row) => sum + (numberOrNull(row.available_quantity) ?? 0), 0);
  const fullCoverageDays = calculateCoverageDays(fullAvailable, velocity.avgDailySales30, velocity.salesVelocityReady);
  const accounts = baseAccounts.map((account) => ({
    ...account,
    coverageDays: calculateCoverageDays(account.available, velocity.avgDailySales30, velocity.salesVelocityReady),
  }));
  physical = { ...physical, coverageDays: physicalCoverageDays };

  return {
    product: { id: product.id, organizationId: product.organization_id, sku: product.sku, skuKey: product.sku_key, name: product.name },
    mapping,
    kitDefinitionIssue,
    physical,
    full: {
      applicable: inventoryTargets.length > 0,
      ready: inventoryTargets.length > 0 && relevantFullRows.length === inventoryTargets.length,
      inventoryCount: inventoryTargets.length,
      checkedInventoryCount: relevantFullRows.length,
      pendingInventoryCount: inventoryTargets.length - relevantFullRows.length,
      available: fullAvailable,
      total: relevantFullRows.reduce((sum, row) => sum + (numberOrNull(row.total_quantity) ?? 0), 0),
      notAvailable: relevantFullRows.reduce((sum, row) => sum + (numberOrNull(row.not_available_quantity) ?? 0), 0),
      notAvailableByStatus,
      accounts,
      coverageDays: fullCoverageDays,
      checkedAt: latestIso(relevantFullRows.map((row) => row.checked_at)),
    },
    advertised: {
      listingCount: advertisedOffers.length,
      activeListingCount: advertisedOffers.filter((offer) => offer.status === "active").length,
      availabilityPublished: advertisedOffers.reduce((sum, offer) => sum + (offer.available ?? 0), 0),
      offers: advertisedOffers,
    },
    planning: {
      brand,
      purchaseLeadTimeDays: purchaseLeadTimeDays(brand),
      periodFrom,
      periodTo,
      unitsSold30: velocity.unitsSold30,
      avgDailySales30: velocity.avgDailySales30,
      physicalCoverageDays,
      fullCoverageDays,
      salesVelocityReady: velocity.salesVelocityReady,
      noSales: velocity.noSales,
    },
  };
}
