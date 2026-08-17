import { NextResponse } from "next/server";

import { getAdminApiAccess } from "@/features/auth/get-admin-api-access";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const authorization = await getAdminApiAccess();
  if (!authorization.access) return NextResponse.json({ error: "not_authorized" }, { status: authorization.status });
  const admin = createAdminClient();
  const [{ data, error }, { data: latestImport, error: latestImportError }] = await Promise.all([
    admin.rpc("get_stock_backend_status", {
      target_organization_id: authorization.access.organizationId,
    }),
    admin.from("upseller_import_batches")
      .select("id,status,phase,cursor_row,attempt_count,max_attempts,error_code,created_at,updated_at,applied_at,preview_summary")
      .eq("organization_id", authorization.access.organizationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (error || latestImportError) {
    console.error("Stock backend status failed:", (error?.message ?? latestImportError?.message ?? "unknown_error").slice(0, 500));
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
    payload.latestUpSellerImport = latestImport ? {
      id: latestImport.id,
      status: latestImport.status,
      phase: latestImport.phase,
      progress: {
        cursor: latestImport.cursor_row,
        stockRows: Number((latestImport.preview_summary as Record<string, unknown> | null)?.stockRows ?? 0),
        productRows: Number((latestImport.preview_summary as Record<string, unknown> | null)?.productRows ?? 0),
        relationshipRows: Number((latestImport.preview_summary as Record<string, unknown> | null)?.relationshipRows ?? 0),
        kitRows: Number((latestImport.preview_summary as Record<string, unknown> | null)?.kitRows ?? 0),
      },
      attempt: latestImport.attempt_count,
      maxAttempts: latestImport.max_attempts,
      errorCode: latestImport.error_code,
      startedAt: latestImport.created_at,
      updatedAt: latestImport.updated_at,
      appliedAt: latestImport.applied_at,
    } : null;
  }
  return NextResponse.json(data);
}
