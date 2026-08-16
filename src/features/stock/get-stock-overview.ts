import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { calculateKitAvailability } from "@/features/stock/stock-domain";
import { createClient } from "@/lib/supabase/server";

const PAGE_SIZE = 800;
const MAX_PAGES = 25;

type ProductRow = {
  id: string;
  sku: string;
  name: string | null;
};

type InventoryLinkRow = {
  product_id: string;
  source_sku: string;
  source_sku_key: string;
  source_kind: "simple" | "kit";
};

type InventoryConflictRow = {
  product_id: string;
};

type StockStateRow = {
  sku_key: string;
  warehouse_key: string;
  available_quantity: number | string;
  current_quantity: number | string;
  low_stock_threshold: number | string;
  checked_at: string;
};

type KitRow = {
  kit_sku_key: string;
};

type KitComponentRow = {
  kit_sku_key: string;
  component_sku_key: string;
  required_quantity: number;
};

type ListingRow = {
  id: string;
  product_id: string | null;
  ml_account_id: string;
  status: string | null;
  available_quantity: number | null;
  inventory_id: string | null;
  ml_last_updated: string | null;
};

type VariationRow = {
  id: string;
  product_id: string | null;
  ml_account_id: string;
  ml_listing_id: string;
  available_quantity: number | null;
  inventory_id: string | null;
  last_seen_at: string;
};

type FulfillmentStateRow = {
  ml_account_id: string;
  inventory_id: string;
  available_quantity: number;
  total_quantity: number;
  not_available_quantity: number;
  checked_at: string;
};

type AlertRow = {
  product_id: string;
  severity: "critical" | "warning" | "info";
};

type QueryPage<T> = {
  data: T[] | null;
  error: {
    message: string;
  } | null;
};

type Offer = {
  accountId: string;
  status: string | null;
  available: number | null;
  inventoryId: string | null;
  updatedAt: string | null;
};

export type StockOverviewStatus =
  | "critical"
  | "warning"
  | "healthy"
  | "pending";

export type StockOverviewRow = {
  id: string;
  sku: string;
  name: string | null;
  mappingStatus: "linked" | "conflict" | "missing";
  sourceSku: string | null;
  sourceKind: "simple" | "kit" | null;
  physicalReady: boolean;
  physicalAvailable: number | null;
  physicalCurrent: number | null;
  lowStockThreshold: number | null;
  fullApplicable: boolean;
  fullReady: boolean;
  fullAvailable: number | null;
  fullPending: number;
  advertisedOffers: number;
  activeOffers: number;
  advertisedAvailable: number | null;
  openAlerts: number;
  alertSeverity: "critical" | "warning" | "info" | null;
  status: StockOverviewStatus;
  updatedAt: string | null;
};

export type StockOverview = {
  sourceConnected: boolean;
  summary: {
    totalProducts: number;
    listedProducts: number;
    mappedProducts: number;
    conflictingProducts: number;
    physicalReadyProducts: number;
    fullTrackedProducts: number;
    attentionProducts: number;
    openAlerts: number;
  };
  products: StockOverviewRow[];
};

async function collectPages<T>(
  label: string,
  loadPage: (
    from: number,
    to: number,
  ) => PromiseLike<QueryPage<T>>,
) {
  const rows: T[] = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await loadPage(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`${label}:${error.message}`);
    }

    const pageRows = data ?? [];
    rows.push(...pageRows);

    if (pageRows.length < PAGE_SIZE) {
      return rows;
    }
  }

  throw new Error(`${label}:result_limit_exceeded`);
}

function numberOrZero(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestIso(values: (string | null | undefined)[]) {
  let latest: string | null = null;

  for (const value of values) {
    if (value && (!latest || value > latest)) {
      latest = value;
    }
  }

  return latest;
}

function pushToMap<T>(map: Map<string, T[]>, key: string, value: T) {
  const current = map.get(key);
  if (current) current.push(value);
  else map.set(key, [value]);
}

function severityOf(alerts: AlertRow[]) {
  if (alerts.some((alert) => alert.severity === "critical")) return "critical" as const;
  if (alerts.some((alert) => alert.severity === "warning")) return "warning" as const;
  if (alerts.some((alert) => alert.severity === "info")) return "info" as const;
  return null;
}

function classifyStatus({
  mappingStatus,
  physicalReady,
  physicalAvailable,
  fullApplicable,
  fullReady,
  fullAvailable,
  activeOffers,
  advertisedAvailable,
  alertSeverity,
}: Pick<
  StockOverviewRow,
  | "mappingStatus"
  | "physicalReady"
  | "physicalAvailable"
  | "fullApplicable"
  | "fullReady"
  | "fullAvailable"
  | "activeOffers"
  | "advertisedAvailable"
  | "alertSeverity"
>): StockOverviewStatus {
  if (
    alertSeverity === "critical" ||
    (physicalReady && physicalAvailable === 0) ||
    (fullReady && fullAvailable === 0)
  ) {
    return "critical";
  }

  if (
    alertSeverity === "warning" ||
    mappingStatus === "conflict" ||
    (mappingStatus === "linked" && !physicalReady) ||
    (fullApplicable && !fullReady) ||
    (activeOffers > 0 && advertisedAvailable === 0)
  ) {
    return "warning";
  }

  if (mappingStatus === "linked" && physicalReady) {
    return "healthy";
  }

  return "pending";
}

export async function getStockOverview(): Promise<StockOverview | null> {
  const access = await getCurrentAccess();
  if (!access) return null;

  const supabase = await createClient();
  const organizationId = access.organizationId;

  const [
    products,
    links,
    conflicts,
    stockStates,
    kits,
    kitComponents,
    listings,
    variations,
    fulfillmentStates,
    alerts,
  ] = await Promise.all([
    collectPages<ProductRow>("STOCK_OVERVIEW_PRODUCTS_FAILED", (from, to) =>
      supabase
        .from("products")
        .select("id,sku,name")
        .eq("organization_id", organizationId)
        .order("sku", { ascending: true })
        .range(from, to)
        .returns<ProductRow[]>(),
    ),
    collectPages<InventoryLinkRow>("STOCK_OVERVIEW_LINKS_FAILED", (from, to) =>
      supabase
        .from("product_inventory_links")
        .select("product_id,source_sku,source_sku_key,source_kind")
        .eq("organization_id", organizationId)
        .eq("source", "upseller")
        .eq("is_active", true)
        .order("product_id", { ascending: true })
        .range(from, to)
        .returns<InventoryLinkRow[]>(),
    ),
    collectPages<InventoryConflictRow>("STOCK_OVERVIEW_CONFLICTS_FAILED", (from, to) =>
      supabase
        .from("product_inventory_link_conflicts")
        .select("product_id")
        .eq("organization_id", organizationId)
        .eq("source", "upseller")
        .eq("is_current", true)
        .order("product_id", { ascending: true })
        .range(from, to)
        .returns<InventoryConflictRow[]>(),
    ),
    collectPages<StockStateRow>("STOCK_OVERVIEW_PHYSICAL_FAILED", (from, to) =>
      supabase
        .from("upseller_stock_states")
        .select("sku_key,warehouse_key,available_quantity,current_quantity,low_stock_threshold,checked_at")
        .eq("organization_id", organizationId)
        .order("sku_key", { ascending: true })
        .order("warehouse_key", { ascending: true })
        .range(from, to)
        .returns<StockStateRow[]>(),
    ),
    collectPages<KitRow>("STOCK_OVERVIEW_KITS_FAILED", (from, to) =>
      supabase
        .from("upseller_kits")
        .select("kit_sku_key")
        .eq("organization_id", organizationId)
        .eq("is_current", true)
        .order("kit_sku_key", { ascending: true })
        .range(from, to)
        .returns<KitRow[]>(),
    ),
    collectPages<KitComponentRow>("STOCK_OVERVIEW_KIT_COMPONENTS_FAILED", (from, to) =>
      supabase
        .from("upseller_kit_components")
        .select("kit_sku_key,component_sku_key,required_quantity")
        .eq("organization_id", organizationId)
        .eq("is_current", true)
        .order("kit_sku_key", { ascending: true })
        .range(from, to)
        .returns<KitComponentRow[]>(),
    ),
    collectPages<ListingRow>("STOCK_OVERVIEW_LISTINGS_FAILED", (from, to) =>
      supabase
        .from("ml_listings")
        .select("id,product_id,ml_account_id,status,available_quantity,inventory_id,ml_last_updated")
        .eq("organization_id", organizationId)
        .eq("is_current", true)
        .order("id", { ascending: true })
        .range(from, to)
        .returns<ListingRow[]>(),
    ),
    collectPages<VariationRow>("STOCK_OVERVIEW_VARIATIONS_FAILED", (from, to) =>
      supabase
        .from("ml_listing_variations")
        .select("id,product_id,ml_account_id,ml_listing_id,available_quantity,inventory_id,last_seen_at")
        .eq("organization_id", organizationId)
        .eq("is_current", true)
        .order("id", { ascending: true })
        .range(from, to)
        .returns<VariationRow[]>(),
    ),
    collectPages<FulfillmentStateRow>("STOCK_OVERVIEW_FULL_FAILED", (from, to) =>
      supabase
        .from("ml_fulfillment_stock_states")
        .select("ml_account_id,inventory_id,available_quantity,total_quantity,not_available_quantity,checked_at")
        .eq("organization_id", organizationId)
        .order("ml_account_id", { ascending: true })
        .order("inventory_id", { ascending: true })
        .range(from, to)
        .returns<FulfillmentStateRow[]>(),
    ),
    collectPages<AlertRow>("STOCK_OVERVIEW_ALERTS_FAILED", (from, to) =>
      supabase
        .from("operational_alerts")
        .select("product_id,severity")
        .eq("organization_id", organizationId)
        .eq("status", "open")
        .order("product_id", { ascending: true })
        .range(from, to)
        .returns<AlertRow[]>(),
    ),
  ]);

  const linksByProduct = new Map(links.map((link) => [link.product_id, link]));
  const conflictsByProduct = new Set(conflicts.map((conflict) => conflict.product_id));
  const stockBySku = new Map<string, StockStateRow[]>();
  const componentsByKit = new Map<string, KitComponentRow[]>();
  const kitKeys = new Set(kits.map((kit) => kit.kit_sku_key));
  const listingsById = new Map(listings.map((listing) => [listing.id, listing]));
  const offersByProduct = new Map<string, Offer[]>();
  const alertsByProduct = new Map<string, AlertRow[]>();
  const fulfillmentByTarget = new Map(
    fulfillmentStates.map((state) => [`${state.ml_account_id}:${state.inventory_id}`, state]),
  );

  for (const state of stockStates) pushToMap(stockBySku, state.sku_key, state);
  for (const component of kitComponents) pushToMap(componentsByKit, component.kit_sku_key, component);
  for (const alert of alerts) pushToMap(alertsByProduct, alert.product_id, alert);

  for (const listing of listings) {
    if (!listing.product_id) continue;
    pushToMap(offersByProduct, listing.product_id, {
      accountId: listing.ml_account_id,
      status: listing.status,
      available: listing.available_quantity,
      inventoryId: listing.inventory_id,
      updatedAt: listing.ml_last_updated,
    });
  }

  for (const variation of variations) {
    if (!variation.product_id) continue;
    const parent = listingsById.get(variation.ml_listing_id);
    pushToMap(offersByProduct, variation.product_id, {
      accountId: variation.ml_account_id,
      status: parent?.status ?? null,
      available: variation.available_quantity ?? parent?.available_quantity ?? null,
      inventoryId: variation.inventory_id,
      updatedAt: parent?.ml_last_updated ?? variation.last_seen_at,
    });
  }

  const rows: StockOverviewRow[] = products.map((product) => {
    const link = linksByProduct.get(product.id);
    const hasConflict = conflictsByProduct.has(product.id);
    const mappingStatus = hasConflict ? "conflict" as const : link ? "linked" as const : "missing" as const;
    const sourceKind = hasConflict ? null : link?.source_kind ?? null;

    let physicalReady = false;
    let physicalAvailable: number | null = null;
    let physicalCurrent: number | null = null;
    let lowStockThreshold: number | null = null;
    let physicalUpdatedAt: string | null = null;

    if (link && !hasConflict && link.source_kind === "simple") {
      const states = stockBySku.get(link.source_sku_key) ?? [];
      physicalReady = states.length > 0;
      if (physicalReady) {
        physicalAvailable = states.reduce((sum, state) => sum + numberOrZero(state.available_quantity), 0);
        physicalCurrent = states.reduce((sum, state) => sum + numberOrZero(state.current_quantity), 0);
        lowStockThreshold = states.reduce((sum, state) => sum + numberOrZero(state.low_stock_threshold), 0);
        physicalUpdatedAt = latestIso(states.map((state) => state.checked_at));
      }
    }

    if (link && !hasConflict && link.source_kind === "kit") {
      const components = componentsByKit.get(link.source_sku_key) ?? [];
      const nestedKit = components.some((component) => kitKeys.has(component.component_sku_key));
      const componentStates = components.flatMap((component) => stockBySku.get(component.component_sku_key) ?? []);

      if (!nestedKit) {
        const availability = calculateKitAvailability(
          components.map((component) => ({
            skuKey: component.component_sku_key,
            requiredQuantity: component.required_quantity,
          })),
          componentStates.map((state) => ({
            skuKey: state.sku_key,
            warehouseKey: state.warehouse_key,
            availableQuantity: numberOrZero(state.available_quantity),
          })),
        );
        physicalReady = availability.ready;
        physicalAvailable = availability.available;
      }

      physicalUpdatedAt = latestIso(componentStates.map((state) => state.checked_at));
    }

    const offers = offersByProduct.get(product.id) ?? [];
    const inventoryTargets = [...new Map(
      offers
        .filter((offer) => offer.inventoryId)
        .map((offer) => [
          `${offer.accountId}:${offer.inventoryId}`,
          { accountId: offer.accountId, inventoryId: offer.inventoryId as string },
        ]),
    ).values()];
    const fullStates = inventoryTargets.flatMap((target) => {
      const state = fulfillmentByTarget.get(`${target.accountId}:${target.inventoryId}`);
      return state ? [state] : [];
    });
    const fullApplicable = inventoryTargets.length > 0;
    const fullReady = fullApplicable && fullStates.length === inventoryTargets.length;
    const fullAvailable = fullStates.length
      ? fullStates.reduce((sum, state) => sum + state.available_quantity, 0)
      : null;
    const advertisedAvailable = offers.length
      ? offers.reduce((sum, offer) => sum + (offer.available ?? 0), 0)
      : null;
    const productAlerts = alertsByProduct.get(product.id) ?? [];
    const alertSeverity = severityOf(productAlerts);
    const activeOffers = offers.filter((offer) => offer.status === "active").length;

    const status = classifyStatus({
      mappingStatus,
      physicalReady,
      physicalAvailable,
      fullApplicable,
      fullReady,
      fullAvailable,
      activeOffers,
      advertisedAvailable,
      alertSeverity,
    });

    return {
      id: product.id,
      sku: product.sku,
      name: product.name,
      mappingStatus,
      sourceSku: hasConflict ? null : link?.source_sku ?? null,
      sourceKind,
      physicalReady,
      physicalAvailable,
      physicalCurrent,
      lowStockThreshold,
      fullApplicable,
      fullReady,
      fullAvailable,
      fullPending: Math.max(inventoryTargets.length - fullStates.length, 0),
      advertisedOffers: offers.length,
      activeOffers,
      advertisedAvailable,
      openAlerts: productAlerts.length,
      alertSeverity,
      status,
      updatedAt: latestIso([
        physicalUpdatedAt,
        ...fullStates.map((state) => state.checked_at),
        ...offers.map((offer) => offer.updatedAt),
      ]),
    };
  });

  const statusOrder: Record<StockOverviewStatus, number> = {
    critical: 0,
    warning: 1,
    pending: 2,
    healthy: 3,
  };

  rows.sort((left, right) =>
    statusOrder[left.status] - statusOrder[right.status] ||
    left.sku.localeCompare(right.sku, "pt-BR", { numeric: true }),
  );

  return {
    sourceConnected:
      links.length > 0 ||
      conflicts.length > 0 ||
      stockStates.length > 0 ||
      kits.length > 0,
    summary: {
      totalProducts: rows.length,
      listedProducts: rows.filter((row) => row.advertisedOffers > 0).length,
      mappedProducts: rows.filter((row) => row.mappingStatus === "linked").length,
      conflictingProducts: rows.filter((row) => row.mappingStatus === "conflict").length,
      physicalReadyProducts: rows.filter((row) => row.physicalReady).length,
      fullTrackedProducts: rows.filter((row) => row.fullApplicable).length,
      attentionProducts: rows.filter((row) => row.status === "critical" || row.status === "warning").length,
      openAlerts: rows.reduce((sum, row) => sum + row.openAlerts, 0),
    },
    products: rows,
  };
}
