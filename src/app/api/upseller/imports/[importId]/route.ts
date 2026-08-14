import { NextResponse } from "next/server";

import { getAdminApiAccess } from "@/features/auth/get-admin-api-access";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ importId: string }> }) {
  const authorization = await getAdminApiAccess();
  if (!authorization.access) return NextResponse.json({ error: "not_authorized" }, { status: authorization.status });
  const { importId } = await context.params;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("upseller_import_batches")
    .select("id,status,phase,cursor_row,attempt_count,max_attempts,next_attempt_at,preview_summary,validation_issues,error_code,error_message,created_at,updated_at,applied_at")
    .eq("id", importId)
    .eq("organization_id", authorization.access.organizationId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "import_lookup_failed" }, { status: 500 });
  if (!data) return NextResponse.json({ error: "import_not_found" }, { status: 404 });
  return NextResponse.json(data);
}
