import { NextResponse } from "next/server";

import { getOpportunitiesAccess } from "@/features/auth/get-opportunities-access";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { access, canDismissOrAnalyze } = await getOpportunitiesAccess();
  if (!access) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  if (!canDismissOrAnalyze) return NextResponse.json({ error: "insufficient_role" }, { status: 403 });

  const admin = createAdminClient();
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("product_opportunities")
    .update({ status: "dismissed", dismissed_at: now, dismissed_by: access.userId, updated_at: now })
    .eq("id", id)
    .eq("organization_id", access.organizationId)
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "internal_error" }, { status: 500 });
  if (!data) return NextResponse.json({ error: "opportunity_not_found" }, { status: 404 });

  await admin.from("product_opportunity_events").insert({ organization_id: access.organizationId, opportunity_id: id, event_type: "dismissed", actor_id: access.userId, detail: {} });

  return NextResponse.json({ status: "dismissed" });
}
