import { redirect } from "next/navigation";

import { StockOverviewView } from "@/components/stock/stock-overview-view";
import { getStockOverview } from "@/features/stock/get-stock-overview";

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
  "ready",
  "full",
  "kits",
]);

export default async function StockPage({
  searchParams,
}: StockPageProps) {
  const [overview, rawSearchParams] = await Promise.all([
    getStockOverview(),
    searchParams,
  ]);

  if (!overview) {
    redirect("/login");
  }

  const rawQuery = Array.isArray(rawSearchParams.q)
    ? rawSearchParams.q[0]
    : rawSearchParams.q;
  const rawStatus = Array.isArray(rawSearchParams.status)
    ? rawSearchParams.status[0]
    : rawSearchParams.status;

  return (
    <StockOverviewView
      overview={overview}
      query={rawQuery?.trim().slice(0, 100) ?? ""}
      status={allowedStatuses.has(rawStatus ?? "") ? rawStatus ?? "all" : "all"}
    />
  );
}
