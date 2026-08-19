import { NextResponse } from "next/server";

import { getOpportunitiesAccess } from "@/features/auth/get-opportunities-access";
import { isAnthropicConfigured } from "@/integrations/anthropic/client";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Enqueues the exact same product_diagnostic_jobs row a manual /produto click would — no separate Claude-calling code for opportunities, full reuse of the ETAPA 36 queue. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { access, canDismissOrAnalyze } = await getOpportunitiesAccess();
  if (!access) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  if (!canDismissOrAnalyze) return NextResponse.json({ error: "insufficient_role" }, { status: 403 });

  if (!isAnthropicConfigured()) {
    return NextResponse.json({ status: "anthropic_not_configured" }, { status: 200 });
  }

  const admin = createAdminClient();
  const { data: opportunity, error: opportunityError } = await admin
    .from("product_opportunities")
    .select("id,product_id")
    .eq("id", id)
    .eq("organization_id", access.organizationId)
    .maybeSingle();
  if (opportunityError) return NextResponse.json({ error: "internal_error" }, { status: 500 });
  if (!opportunity) return NextResponse.json({ error: "opportunity_not_found" }, { status: 404 });

  const { data: job, error: insertError } = await admin
    .from("product_diagnostic_jobs")
    .insert({ organization_id: access.organizationId, product_id: opportunity.product_id, requested_by: access.userId, force: false })
    .select("id")
    .single();

  if (insertError) {
    if (insertError.code === "23505") return NextResponse.json({ status: "analysis_in_progress" }, { status: 409 });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  admin.rpc("dispatch_ml_sync_worker_task", { worker_task: "product_diagnostic" }).then(
    () => {},
    () => {},
  );

  return NextResponse.json({ status: "queued", jobId: job.id, productId: opportunity.product_id });
}
