import { redirect } from "next/navigation";

import { DashboardOverviewView } from "@/components/dashboard/dashboard-overview-view";
import { readDashboardSearchParams } from "@/features/dashboard/dashboard-search-params";
import { getDashboardOverview } from "@/features/dashboard/get-dashboard-overview";

export const metadata = {
  title: "Visão Geral",
};

type DashboardPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const params = readDashboardSearchParams(await searchParams);

  const dashboard = await getDashboardOverview(params);

  if (!dashboard) {
    redirect("/login");
  }

  return <DashboardOverviewView dashboard={dashboard} />;
}
