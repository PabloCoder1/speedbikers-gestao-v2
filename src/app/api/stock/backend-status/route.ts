import { NextResponse } from "next/server";

import { getAdminApiAccess } from "@/features/auth/get-admin-api-access";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const authorization = await getAdminApiAccess();
  if (!authorization.access) return NextResponse.json({ error: "not_authorized" }, { status: authorization.status });
  const { data, error } = await createAdminClient().rpc("get_stock_backend_status", {
    target_organization_id: authorization.access.organizationId,
  });
  if (error) {
    console.error("Stock backend status failed:", error.message.slice(0, 500));
    return NextResponse.json({ error: "backend_status_failed" }, { status: 500 });
  }
  if (data && typeof data === "object" && "readiness" in data) {
    const payload = data as Record<string, unknown>;
    const readiness = payload.readiness && typeof payload.readiness === "object"
      ? payload.readiness as Record<string, unknown>
      : {};
    payload.readiness = {
      ...readiness,
      upsellerImportApplied: readiness.upsellerImportApplied === true,
      mappingPipelineWorking: readiness.mappingPipelineWorking === true,
      fullPipelineWorking: readiness.fullPipelineWorking === true,
      readyForVisualStage: readiness.readyForVisualStage === true,
    };
  }
  return NextResponse.json(data);
}
