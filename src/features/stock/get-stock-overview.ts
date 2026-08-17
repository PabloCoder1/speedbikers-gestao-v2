import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { createClient } from "@/lib/supabase/server";

export type StockOverviewStatus =
  | "critical"
  | "warning"
  | "healthy"
  | "pending";

export type StockOverviewFilter =
  | "all"
  | "attention"
  | "unmapped"
  | "conflicts"
  | "ready"
  | "full"
  | "kits";

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
  matchCount: number;
};

type StockOverviewSummaryReadModel = StockOverview["summary"] & {
  sourceConnected: boolean;
  stockReceiptReady: boolean;
  warehouses: StockOverview["warehouses"];
};

type StockOverviewPageReadModel = {
  products: StockOverviewRow[];
  matchCount: number;
};

export async function getStockOverview({
  query = "",
  status = "all",
  limit = 200,
}: {
  query?: string;
  status?: StockOverviewFilter;
  limit?: number;
} = {}): Promise<StockOverview | null> {
  const access = await getCurrentAccess();
  if (!access) return null;

  const supabase = await createClient();
  const organizationId = access.organizationId;
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);

  const [summaryResult, pageResult] = await Promise.all([
    supabase.rpc("get_stock_overview_summary", {
      target_organization_id: organizationId,
    }),
    supabase.rpc("get_stock_overview_page", {
      target_organization_id: organizationId,
      search_query: query,
      status_filter: status,
      result_limit: safeLimit,
    }),
  ]);

  if (summaryResult.error || !summaryResult.data) {
    throw new Error(
      `STOCK_OVERVIEW_SUMMARY_FAILED:${summaryResult.error?.message ?? "empty_result"}`,
    );
  }

  if (pageResult.error || !pageResult.data) {
    throw new Error(
      `STOCK_OVERVIEW_PAGE_FAILED:${pageResult.error?.message ?? "empty_result"}`,
    );
  }

  const summary = summaryResult.data as unknown as StockOverviewSummaryReadModel;
  const page = pageResult.data as unknown as StockOverviewPageReadModel;

  return {
    sourceConnected: summary.sourceConnected === true,
    canReceiveStock: ["admin", "gestor", "operador"].includes(access.role),
    canImportUpseller: access.role === "admin",
    stockReceiptReady: summary.stockReceiptReady === true,
    warehouses: Array.isArray(summary.warehouses) ? summary.warehouses : [],
    summary: {
      totalProducts: Number(summary.totalProducts ?? 0),
      listedProducts: Number(summary.listedProducts ?? 0),
      mappedProducts: Number(summary.mappedProducts ?? 0),
      conflictingProducts: Number(summary.conflictingProducts ?? 0),
      physicalReadyProducts: Number(summary.physicalReadyProducts ?? 0),
      fullTrackedProducts: Number(summary.fullTrackedProducts ?? 0),
      attentionProducts: Number(summary.attentionProducts ?? 0),
      openAlerts: Number(summary.openAlerts ?? 0),
    },
    products: Array.isArray(page.products) ? page.products : [],
    matchCount: Number(page.matchCount ?? 0),
  };
}
