import { redirect } from "next/navigation";

import { StockOverviewView } from "@/components/stock/stock-overview-view";
import {
  getStockOverview,
  type StockOverviewFilter,
} from "@/features/stock/get-stock-overview";

export const metadata = {
  title: "Estoque",
};

type StockPageProps = {
  searchParams: Promise<{
    q?: string | string[];
    status?: string | string[];
  }>;
};

const allowedStatuses = new Set([
  "all",
  "attention",
  "unmapped",
  "conflicts",
  "ready",
  "full",
  "kits",
]);

export default async function StockPage({
  searchParams,
}: StockPageProps) {
  const rawSearchParams = await searchParams;

  const rawQuery = Array.isArray(rawSearchParams.q)
    ? rawSearchParams.q[0]
    : rawSearchParams.q;
  const rawStatus = Array.isArray(rawSearchParams.status)
    ? rawSearchParams.status[0]
    : rawSearchParams.status;
  const query = rawQuery?.trim().slice(0, 100) ?? "";
  const status = (
    allowedStatuses.has(rawStatus ?? "") ? rawStatus : "all"
  ) as StockOverviewFilter;
  const overview = await getStockOverview({ query, status, limit: 200 });

  if (!overview) {
    redirect("/login");
  }

  return (
    <StockOverviewView
      overview={overview}
      query={query}
      status={status}
    />
  );
}
