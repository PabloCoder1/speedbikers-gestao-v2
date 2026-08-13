import {
  redirect,
} from "next/navigation";

import {
  DashboardOverviewView,
} from "@/components/dashboard/dashboard-overview-view";
import {
  getDashboardOverview,
} from "@/features/dashboard/get-dashboard-overview";

type AccountDashboardPageProps = {
  params:
    Promise<{
      accountCode:
        string;
    }>;
};

export default async function AccountDashboardPage({
  params,
}: AccountDashboardPageProps) {
  const {
    accountCode,
  } = await params;

  const dashboard =
    await getDashboardOverview({
      accountCode,
    });

  if (!dashboard) {
    redirect(
      "/login",
    );
  }

  return (
    <DashboardOverviewView
      dashboard={
        dashboard
      }
    />
  );
}
