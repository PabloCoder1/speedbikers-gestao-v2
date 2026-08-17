import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { calculateKitAvailability } from "@/features/stock/stock-domain";
import { createClient } from "@/lib/supabase/server";

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
  warehouse_name: string;
  warehouse_key: string;
  available_quantity: number | string;
  current_quantity: number | string;
  low_stock_threshold: number | string;
  source_import_id: string;
  checked_at: string;
};

type ReceiptAdjustmentRow = {
  sku_key: string;
  warehouse_key: string;
  quantity: number | string;
  applied_at: string;
};

type MlAccountRow = {
  id: string;
  code: string;
  display_name: string;
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
  fullPending: number;
  fullAccounts: {
    accountId: string;
    accountCode: string | null;
    accountName: string;
    available: number | null;
    inventoryCount: number;
    checkedInventoryCount: number;
    pendingInventoryCount: number;
    ready: boolean;
  }[];
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
  canReceiveStock: boolean;
  canImportUpseller: boolean;
  stockReceiptReady: boolean;
  warehouses: {
    key: string;
    name: string;
  }[];
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

type StockOverviewReadModel = {
  stockReceiptReady: boolean;
  products: ProductRow[];
  links: InventoryLinkRow[];
  conflicts: InventoryConflictRow[];
  stockStates: StockStateRow[];
  kits: KitRow[];
  kitComponents: KitComponentRow[];
  listings: ListingRow[];
  variations: VariationRow[];
  fulfillmentStates: FulfillmentStateRow[];
  mlAccounts: MlAccountRow[];
  receiptAdjustments: ReceiptAdjustmentRow[];
  alerts: AlertRow[];
};

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
  fullHasZero,
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
  | "activeOffers"
  | "advertisedAvailable"
  | "alertSeverity"
> & { fullHasZero: boolean }): StockOverviewStatus {
  if (
    alertSeverity === "critical" ||
    (physicalReady && physicalAvailable === 0) ||
    fullHasZero
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

  const { data, error } = await supabase.rpc("get_stock_overview_data", {
    target_organization_id: organizationId,
  });
  if (error || !data || typeof data !== "object") {
    throw new Error(`STOCK_OVERVIEW_READ_MODEL_FAILED:${error?.message ?? "empty_result"}`);
  }
  const readModel = data as unknown as StockOverviewReadModel;
  const {
    products = [], links = [], conflicts = [], stockStates = [], kits = [],
    kitComponents = [], listings = [], variations = [], fulfillmentStates = [],
    mlAccounts = [], receiptAdjustments = [], alerts = [],
  } = readModel;
  const receiptAdjustmentsResult = {
    rows: receiptAdjustments,
    ready: readModel.stockReceiptReady === true,
  };

  const linksByProduct = new Map(links.map((link) => [link.product_id, link]));
  const conflictsByProduct = new Set(conflicts.map((conflict) => conflict.product_id));
  const stockBySku = new Map<string, StockStateRow[]>();
  const componentsByKit = new Map<string, KitComponentRow[]>();
  const kitKeys = new Set(kits.map((kit) => kit.kit_sku_key));
  const listingsById = new Map(listings.map((listing) => [listing.id, listing]));
  const offersByProduct = new Map<string, Offer[]>();
  const alertsByProduct = new Map<string, AlertRow[]>();
  const accountsById = new Map(mlAccounts.map((account) => [account.id, account]));
  const receiptAdjustmentsByTarget = new Map<string, ReceiptAdjustmentRow[]>();
  const fulfillmentByTarget = new Map(
    fulfillmentStates.map((state) => [`${state.ml_account_id}:${state.inventory_id}`, state]),
  );

  for (const state of stockStates) pushToMap(stockBySku, state.sku_key, state);
  for (const adjustment of receiptAdjustmentsResult.rows) {
    pushToMap(
      receiptAdjustmentsByTarget,
      `${adjustment.sku_key}:${adjustment.warehouse_key}`,
      adjustment,
    );
  }
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
        physicalAvailable = states.reduce((sum, state) => {
          const adjustments = receiptAdjustmentsByTarget.get(`${state.sku_key}:${state.warehouse_key}`) ?? [];
          return sum + numberOrZero(state.available_quantity) + adjustments.reduce(
            (adjustmentSum, adjustment) => adjustmentSum + numberOrZero(adjustment.quantity),
            0,
          );
        }, 0);
        physicalCurrent = states.reduce((sum, state) => {
          const adjustments = receiptAdjustmentsByTarget.get(`${state.sku_key}:${state.warehouse_key}`) ?? [];
          return sum + numberOrZero(state.current_quantity) + adjustments.reduce(
            (adjustmentSum, adjustment) => adjustmentSum + numberOrZero(adjustment.quantity),
            0,
          );
        }, 0);
        lowStockThreshold = states.reduce((sum, state) => sum + numberOrZero(state.low_stock_threshold), 0);
        physicalUpdatedAt = latestIso([
          ...states.map((state) => state.checked_at),
          ...states.flatMap((state) => (
            receiptAdjustmentsByTarget.get(`${state.sku_key}:${state.warehouse_key}`) ?? []
          ).map((adjustment) => adjustment.applied_at)),
        ]);
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
            availableQuantity:
              numberOrZero(state.available_quantity) +
              (receiptAdjustmentsByTarget.get(`${state.sku_key}:${state.warehouse_key}`) ?? [])
                .reduce(
                  (sum, adjustment) => sum + numberOrZero(adjustment.quantity),
                  0,
                ),
          })),
        );
        physicalReady = availability.ready;
        physicalAvailable = availability.available;
      }

      physicalUpdatedAt = latestIso([
        ...componentStates.map((state) => state.checked_at),
        ...componentStates.flatMap((state) => (
          receiptAdjustmentsByTarget.get(`${state.sku_key}:${state.warehouse_key}`) ?? []
        ).map((adjustment) => adjustment.applied_at)),
      ]);
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
    const fullAccounts = [...new Set(inventoryTargets.map((target) => target.accountId))]
      .map((accountId) => {
        const accountTargets = inventoryTargets.filter((target) => target.accountId === accountId);
        const accountStates = accountTargets.flatMap((target) => {
          const state = fulfillmentByTarget.get(`${target.accountId}:${target.inventoryId}`);
          return state ? [state] : [];
        });
        const account = accountsById.get(accountId);
        const ready = accountStates.length === accountTargets.length;
        return {
          accountId,
          accountCode: account?.code ?? null,
          accountName: account?.display_name ?? account?.code ?? "Conta Mercado Livre",
          available: accountStates.length
            ? accountStates.reduce((sum, state) => sum + state.available_quantity, 0)
            : null,
          inventoryCount: accountTargets.length,
          checkedInventoryCount: accountStates.length,
          pendingInventoryCount: Math.max(accountTargets.length - accountStates.length, 0),
          ready,
        };
      })
      .sort((left, right) => left.accountName.localeCompare(right.accountName, "pt-BR"));
    const fullHasZero = physicalReady && physicalAvailable !== null && physicalAvailable > 0 &&
      fullAccounts.some((account) => account.ready && account.available === 0);
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
      fullHasZero,
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
      fullPending: Math.max(inventoryTargets.length - fullStates.length, 0),
      fullAccounts,
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
    canReceiveStock: ["admin", "gestor", "operador"].includes(access.role),
    canImportUpseller: access.role === "admin",
    stockReceiptReady: receiptAdjustmentsResult.ready,
    warehouses: [...new Map(
      stockStates.map((state) => [state.warehouse_key, {
        key: state.warehouse_key,
        name: state.warehouse_name,
      }]),
    ).values()].sort((left, right) => left.name.localeCompare(right.name, "pt-BR")),
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
