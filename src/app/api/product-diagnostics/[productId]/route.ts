import { NextResponse } from "next/server";

import { getProductDiagnosticsAccess } from "@/features/auth/get-product-diagnostics-access";
import { getProductDashboard } from "@/features/dashboard/get-product-dashboard";
import { isAnthropicConfigured } from "@/integrations/anthropic/client";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RUN_SELECT_COLUMNS = "id,status,model,prompt_version,evidence_hash,evidence,result,error_code,error_message,created_at,completed_at";

type RunRow = {
  id: string;
  status: string;
  model: string;
  prompt_version: string;
  evidence_hash: string;
  evidence: unknown;
  result: unknown;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
};

function shapeRun(row: RunRow) {
  return {
    id: row.id,
    status: row.status,
    model: row.model,
    promptVersion: row.prompt_version,
    evidenceHash: row.evidence_hash,
    evidence: row.evidence,
    result: row.result,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/** Enqueues a product diagnostic job — the actual analysis runs async in the background worker (Parte H). Responds fast; the client polls GET for progress. */
export async function POST(request: Request, { params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;

  const { access, canGenerate, status: accessStatus } = await getProductDiagnosticsAccess();
  if (!access) return NextResponse.json({ error: "not_authenticated" }, { status: accessStatus });
  if (!canGenerate) return NextResponse.json({ error: "insufficient_role" }, { status: 403 });

  if (!isAnthropicConfigured()) {
    return NextResponse.json({ status: "anthropic_not_configured" }, { status: 200 });
  }

  const dashboard = await getProductDashboard({ productId });
  if (!dashboard || !dashboard.found) {
    return NextResponse.json({ error: "product_not_found" }, { status: 404 });
  }

  let force = false;
  try {
    const body = await request.json();
    force = body?.force === true;
  } catch {
    force = false;
  }

  const admin = createAdminClient();
  const { data: job, error: insertError } = await admin
    .from("product_diagnostic_jobs")
    .insert({ organization_id: access.organizationId, product_id: productId, requested_by: access.userId, force })
    .select("id")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      return NextResponse.json({ status: "analysis_in_progress" }, { status: 409 });
    }
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  console.log(JSON.stringify({ event: "product_diagnostic_job_queued", productId, jobId: job.id }));

  // Fire-and-forget: the per-minute cron is the fallback if this fails.
  admin.rpc("dispatch_ml_sync_worker_task", { worker_task: "product_diagnostic" }).then(
    () => {},
    () => {},
  );

  return NextResponse.json({ status: "queued", jobId: job.id });
}

/** Polls a job's progress. Once the job is done, includes the persisted diagnostic run. */
export async function GET(request: Request, { params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  const { access } = await getProductDiagnosticsAccess();
  if (!access) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });

  const requestUrl = new URL(request.url);
  const jobId = requestUrl.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "job_id_required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: job, error: jobError } = await admin
    .from("product_diagnostic_jobs")
    .select("id,status,phase,error_code,error_message,diagnostic_run_id")
    .eq("organization_id", access.organizationId)
    .eq("product_id", productId)
    .eq("id", jobId)
    .maybeSingle();
  if (jobError) return NextResponse.json({ error: "internal_error" }, { status: 500 });
  if (!job) return NextResponse.json({ error: "job_not_found" }, { status: 404 });

  if (job.status === "queued" || job.status === "running") {
    return NextResponse.json({ status: job.status, phase: job.phase });
  }

  if (job.status === "failed") {
    return NextResponse.json({ status: "failed", errorCode: job.error_code, errorMessage: job.error_message });
  }

  if (!job.diagnostic_run_id) return NextResponse.json({ error: "internal_error" }, { status: 500 });
  const { data: run, error: runError } = await admin.from("product_diagnostic_runs").select(RUN_SELECT_COLUMNS).eq("id", job.diagnostic_run_id).single<RunRow>();
  if (runError || !run) return NextResponse.json({ error: "internal_error" }, { status: 500 });

  return NextResponse.json({ status: "done", run: shapeRun(run) });
}
