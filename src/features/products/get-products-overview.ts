import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { createClient } from "@/lib/supabase/server";

export type ProductsFilter =
  | "all"
  | "with_sales"
  | "without_sales"
  | "alerts"
  | "unmapped"
  | "conflicts"
  | "full";

export type ProductCommercialStatus =
  | "healthy"
  | "attention"
  | "critical"
  | "missing"
  | "conflict";

export type ProductsOverviewRow = {
  id: string;
  sku: string;
  name: string | null;
  accounts: {
    id: string;
    code: string;
    name: string;
  }[];
  activeListings: number;
  unitsSold30: number;
  grossRevenue30: number;
  minimumPrice: number | null;
  maximumPrice: number | null;
  physicalReady: boolean;
  physicalAvailable: number | null;
  fullApplicable: boolean;
  fullAvailable: number | null;
  mappingStatus: "linked" | "conflict" | "missing";
  openAlerts: number;
  alertSeverity: "critical" | "warning" | "info" | null;
  status: ProductCommercialStatus;
};

export type ProductsOverview = {
  summary: {
    totalProducts: number;
    activeProducts: number;
    unitsSold30: number;
    grossRevenue30: number;
  };
  products: ProductsOverviewRow[];
  matchCount: number;
  page: number;
  limit: number;
};

type ProductsReadModel = Omit<ProductsOverview, "page"> & {
  offset: number;
};

export async function getProductsOverview({
  query = "",
  status = "all",
  page = 1,
  limit = 100,
}: {
  query?: string;
  status?: ProductsFilter;
  page?: number;
  limit?: number;
} = {}): Promise<ProductsOverview | null> {
  const access = await getCurrentAccess();
  if (!access) return null;

  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const safePage = Math.max(Math.trunc(page), 1);
  const offset = (safePage - 1) * safeLimit;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_products_overview_data", {
    target_organization_id: access.organizationId,
    search_query: query,
    status_filter: status,
    result_limit: safeLimit,
    result_offset: offset,
  });

  if (error || !data) {
    throw new Error(
      `PRODUCTS_OVERVIEW_READ_MODEL_FAILED:${error?.message ?? "empty_result"}`,
    );
  }

  const readModel = data as unknown as ProductsReadModel;
  const summary = readModel.summary ?? {
    totalProducts: 0,
    activeProducts: 0,
    unitsSold30: 0,
    grossRevenue30: 0,
  };

  return {
    summary: {
      totalProducts: Number(summary.totalProducts ?? 0),
      activeProducts: Number(summary.activeProducts ?? 0),
      unitsSold30: Number(summary.unitsSold30 ?? 0),
      grossRevenue30: Number(summary.grossRevenue30 ?? 0),
    },
    products: Array.isArray(readModel.products) ? readModel.products : [],
    matchCount: Number(readModel.matchCount ?? 0),
    page: safePage,
    limit: safeLimit,
  };
}

