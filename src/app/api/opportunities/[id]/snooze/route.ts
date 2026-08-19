import { NextResponse } from "next/server";

import { getOpportunitiesAccess } from "@/features/auth/get-opportunities-access";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_PRESET_DAYS = new Set([1, 3, 7]);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { access, canSnooze } = await getOpportunitiesAccess();
  if (!access) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  if (!canSnooze) return NextResponse.json({ error: "insufficient_role" }, { status: 403 });

  let body: { days?: number; until?: string } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  let snoozedUntil: string;
  if (typeof body.until === "string") {
    const parsed = new Date(body.until);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      return NextResponse.json({ error: "invalid_snooze_date" }, { status: 400 });
    }
    snoozedUntil = parsed.toISOString();
  } else {
    const days = body.days;
    if (typeof days !== "number" || !ALLOWED_PRESET_DAYS.has(days)) {
      return NextResponse.json({ error: "invalid_snooze_days" }, { status: 400 });
    }
    snoozedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("product_opportunities")
    .update({ status: "snoozed", snoozed_until: snoozedUntil, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", access.organizationId)
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "internal_error" }, { status: 500 });
  if (!data) return NextResponse.json({ error: "opportunity_not_found" }, { status: 404 });

  await admin.from("product_opportunity_events").insert({ organization_id: access.organizationId, opportunity_id: id, event_type: "snoozed", actor_id: access.userId, detail: { snoozedUntil } });

  return NextResponse.json({ status: "snoozed", snoozedUntil });
}
