import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type OrganizationAiSettings = {
  autoOpportunityDiagnosticsEnabled: boolean;
  dailyOpportunityDiagnosticLimit: number;
  updatedAt: string | null;
};

const DEFAULT_SETTINGS: OrganizationAiSettings = { autoOpportunityDiagnosticsEnabled: false, dailyOpportunityDiagnosticLimit: 5, updatedAt: null };

export async function getOrganizationAiSettings(): Promise<OrganizationAiSettings | null> {
  const access = await getCurrentAccess();
  if (!access) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organization_ai_settings")
    .select("auto_opportunity_diagnostics_enabled,daily_opportunity_diagnostic_limit,updated_at")
    .eq("organization_id", access.organizationId)
    .maybeSingle();
  if (error) throw new Error(`ORGANIZATION_AI_SETTINGS_LOOKUP_FAILED:${error.message}`);
  if (!data) return DEFAULT_SETTINGS;

  return {
    autoOpportunityDiagnosticsEnabled: data.auto_opportunity_diagnostics_enabled,
    dailyOpportunityDiagnosticLimit: data.daily_opportunity_diagnostic_limit,
    updatedAt: data.updated_at,
  };
}

/** Caller must already have verified canConfigureAutoClaude. */
export async function updateOrganizationAiSettings(params: { organizationId: string; userId: string; autoOpportunityDiagnosticsEnabled: boolean; dailyOpportunityDiagnosticLimit: number }) {
  const admin = createAdminClient();
  const clampedLimit = Math.min(Math.max(Math.round(params.dailyOpportunityDiagnosticLimit), 1), 20);
  const { error } = await admin.from("organization_ai_settings").upsert({
    organization_id: params.organizationId,
    auto_opportunity_diagnostics_enabled: params.autoOpportunityDiagnosticsEnabled,
    daily_opportunity_diagnostic_limit: clampedLimit,
    updated_by: params.userId,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`ORGANIZATION_AI_SETTINGS_UPDATE_FAILED:${error.message}`);
}
