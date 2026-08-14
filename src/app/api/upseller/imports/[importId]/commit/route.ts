import { NextResponse } from "next/server";

import { getAdminApiAccess } from "@/features/auth/get-admin-api-access";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ importId: string }> }) {
  const authorization = await getAdminApiAccess();
  if (!authorization.access) return NextResponse.json({ error: "not_authorized" }, { status: authorization.status });
  const { importId } = await context.params;
  const admin = createAdminClient();
  const { data: batch, error } = await admin
    .from("upseller_import_batches")
    .select("id,status,validation_issues")
    .eq("id", importId)
    .eq("organization_id", authorization.access.organizationId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "import_lookup_failed" }, { status: 500 });
  if (!batch) return NextResponse.json({ error: "import_not_found" }, { status: 404 });
  if (batch.status !== "previewed") return NextResponse.json({ error: "invalid_import_status" }, { status: 409 });
  const issues = batch.validation_issues as { blockingIssues?: unknown[] } | null;
  if ((issues?.blockingIssues?.length ?? 0) > 0) return NextResponse.json({ error: "import_has_blocking_issues" }, { status: 422 });
  const { data: queued, error: queueError } = await admin
    .from("upseller_import_batches")
    .update({ status: "queued", phase: "stock", cursor_row: 0, next_attempt_at: new Date().toISOString() })
    .eq("id", importId)
    .eq("status", "previewed")
    .select("id,status,phase")
    .maybeSingle();
  if (queueError || !queued) return NextResponse.json({ error: "import_queue_failed" }, { status: 409 });
  return NextResponse.json(queued, { status: 202 });
}
