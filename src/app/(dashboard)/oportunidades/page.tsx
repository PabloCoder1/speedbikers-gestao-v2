import { redirect } from "next/navigation";

import { OpportunitiesView } from "@/components/opportunities/opportunities-view";
import { getCurrentAccess } from "@/features/auth/get-current-access";
import { getOpportunitiesAccess } from "@/features/auth/get-opportunities-access";
import { getProductOpportunitiesPage } from "@/features/opportunities/get-product-opportunities-page";
import { getProductOpportunitiesSummary } from "@/features/opportunities/get-product-opportunities-summary";
import { getOrganizationAiSettings } from "@/features/opportunities/organization-ai-settings";

export default async function OpportunitiesPage() {
  const access = await getCurrentAccess();
  if (!access) redirect("/login");

  const [opportunitiesAccess, summary, opportunities, aiSettings] = await Promise.all([
    getOpportunitiesAccess(),
    getProductOpportunitiesSummary(),
    getProductOpportunitiesPage({ status: "open", pageSize: 50 }),
    getOrganizationAiSettings(),
  ]);

  return (
    <OpportunitiesView
      canSnooze={opportunitiesAccess.canSnooze}
      canDismissOrAnalyze={opportunitiesAccess.canDismissOrAnalyze}
      canConfigureAutoClaude={opportunitiesAccess.canConfigureAutoClaude}
      initialSummary={summary}
      initialOpportunities={opportunities ?? []}
      initialAiSettings={aiSettings}
    />
  );
}
