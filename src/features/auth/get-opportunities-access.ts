import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { canConfigureAutoClaude, canDismissOrAnalyzeOpportunity, canSnoozeOpportunity } from "@/features/opportunities/opportunity-permissions";

export async function getOpportunitiesAccess() {
  const access = await getCurrentAccess();
  if (!access) {
    return { access: null, status: 401 as const, canSnooze: false, canDismissOrAnalyze: false, canConfigureAutoClaude: false };
  }
  return {
    access,
    status: 200 as const,
    canSnooze: canSnoozeOpportunity(access.role, access.mustChangePassword),
    canDismissOrAnalyze: canDismissOrAnalyzeOpportunity(access.role, access.mustChangePassword),
    canConfigureAutoClaude: canConfigureAutoClaude(access.role, access.mustChangePassword),
  };
}
