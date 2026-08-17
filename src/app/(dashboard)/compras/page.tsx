import { redirect } from "next/navigation";

import { PurchasePlanningView } from "@/components/stock/purchase-planning-view";
import {
  getPurchasePlanning,
  type PurchasePlanningFilter,
} from "@/features/stock/get-purchase-planning";

export const metadata = {
  title: "Compras",
};

type PurchasePageProps = {
  searchParams: Promise<{
    q?: string | string[];
    filter?: string | string[];
  }>;
};

const allowedFilters = new Set([
  "all",
  "purchase",
  "urgent",
  "covered",
  "no_sales",
  "insufficient_data",
  "imported",
  "domestic",
]);

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PurchasePlanningPage({ searchParams }: PurchasePageProps) {
  const rawSearchParams = await searchParams;
  const rawFilter = firstValue(rawSearchParams.filter);
  const filter = (
    allowedFilters.has(rawFilter ?? "") ? rawFilter : "all"
  ) as PurchasePlanningFilter;
  const query = firstValue(rawSearchParams.q)?.trim().slice(0, 100) ?? "";

  const overview = await getPurchasePlanning({ filter, query });

  if (!overview) redirect("/login");

  return <PurchasePlanningView overview={overview} query={query} filter={filter} />;
}
