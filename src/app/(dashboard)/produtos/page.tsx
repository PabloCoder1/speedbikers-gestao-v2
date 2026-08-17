import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ProductsOverviewView } from "@/components/products/products-overview-view";
import {
  getProductsOverview,
  type ProductsFilter,
} from "@/features/products/get-products-overview";

export const metadata: Metadata = {
  title: "Produtos",
};

type ProductsPageProps = {
  searchParams: Promise<{
    q?: string | string[];
    status?: string | string[];
    page?: string | string[];
  }>;
};

const allowedStatuses = new Set<ProductsFilter>([
  "all",
  "with_sales",
  "without_sales",
  "alerts",
  "unmapped",
  "conflicts",
  "full",
]);

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ProductsPage({ searchParams }: ProductsPageProps) {
  const params = await searchParams;
  const query = firstValue(params.q)?.trim().slice(0, 100) ?? "";
  const rawStatus = firstValue(params.status) ?? "all";
  const status = allowedStatuses.has(rawStatus as ProductsFilter)
    ? rawStatus as ProductsFilter
    : "all";
  const parsedPage = Number.parseInt(firstValue(params.page) ?? "1", 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0
    ? Math.min(parsedPage, 1000)
    : 1;
  const overview = await getProductsOverview({
    query,
    status,
    page,
    limit: 100,
  });

  if (!overview) {
    redirect("/login");
  }

  return (
    <ProductsOverviewView
      overview={overview}
      query={query}
      status={status}
    />
  );
}

