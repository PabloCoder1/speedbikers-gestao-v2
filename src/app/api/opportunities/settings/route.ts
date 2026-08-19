import { NextResponse } from "next/server";

import { getOpportunitiesAccess } from "@/features/auth/get-opportunities-access";
import { getOrganizationAiSettings, updateOrganizationAiSettings } from "@/features/opportunities/organization-ai-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { access } = await getOpportunitiesAccess();
  if (!access) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });

  const settings = await getOrganizationAiSettings();
  return NextResponse.json({ settings });
}

export async function PUT(request: Request) {
  const { access, canConfigureAutoClaude } = await getOpportunitiesAccess();
  if (!access) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  if (!canConfigureAutoClaude) return NextResponse.json({ error: "insufficient_role" }, { status: 403 });

  let body: { autoOpportunityDiagnosticsEnabled?: boolean; dailyOpportunityDiagnosticLimit?: number } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (typeof body.autoOpportunityDiagnosticsEnabled !== "boolean" || typeof body.dailyOpportunityDiagnosticLimit !== "number") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  await updateOrganizationAiSettings({
    organizationId: access.organizationId,
    userId: access.userId,
    autoOpportunityDiagnosticsEnabled: body.autoOpportunityDiagnosticsEnabled,
    dailyOpportunityDiagnosticLimit: body.dailyOpportunityDiagnosticLimit,
  });

  const settings = await getOrganizationAiSettings();
  return NextResponse.json({ settings });
}
