import { redirect } from "next/navigation";

import { DashboardOverviewView } from "@/components/dashboard/dashboard-overview-view";
import { readDashboardSearchParams } from "@/features/dashboard/dashboard-search-params";
import { getDashboardOverview } from "@/features/dashboard/get-dashboard-overview";

type AccountDashboardPageProps = {
  params: Promise<{ accountCode: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AccountDashboardPage({
  params,
  searchParams,
}: AccountDashboardPageProps) {
  const { accountCode } = await params;
  const dashboardParams = readDashboardSearchParams(await searchParams);

  const dashboard = await getDashboardOverview({
    accountCode,
    ...dashboardParams,
  });

  if (!dashboard) {
    redirect("/login");
  }

  return <DashboardOverviewView dashboard={dashboard} />;
}
