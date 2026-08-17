import { NextResponse } from "next/server";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { createAdminClient } from "@/lib/supabase/admin";

type AccountRow = { id: string; code: string; display_name: string | null };
type Result = {
  accountCode: string;
  accountName: string | null;
  currentListings: number;
  status: "queued" | "already_running" | "empty" | "failed";
};

export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!access) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  if (access.role !== "admin") return NextResponse.json({ error: "not_authorized" }, { status: 403 });
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (body.confirm !== "START") {
    return NextResponse.json({ error: "confirmation_required", message: "Envie confirm=START para iniciar o backfill." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: accountData, error: accountError } = await admin.from("ml_accounts")
    .select("id,code,display_name").eq("organization_id", access.organizationId)
    .eq("is_active", true).eq("connection_status", "connected").returns<AccountRow[]>();
  if (accountError) return NextResponse.json({ error: "accounts_query_failed" }, { status: 500 });
  const results = await Promise.all((accountData ?? []).map(async (account): Promise<Result> => {
    const { count, error: countError } = await admin.from("ml_listings")
      .select("id", { count: "exact", head: true }).eq("organization_id", access.organizationId)
      .eq("ml_account_id", account.id).eq("is_current", true);
    if (countError) {
      return { accountCode: account.code, accountName: account.display_name, currentListings: 0, status: "failed" };
    }
    const total = count ?? 0;
    if (total === 0) {
      return { accountCode: account.code, accountName: account.display_name, currentListings: 0, status: "empty" };
    }
    const { error: insertError } = await admin.from("sync_runs").insert({
      organization_id: access.organizationId, ml_account_id: account.id,
      sync_type: "offer_prices_backfill", status: "queued", cursor_offset: 0,
      batch_size: 8, records_discovered: total, records_processed: 0, records_upserted: 0,
      retry_count: 0, max_retries: 3, requested_by: access.userId,
      metadata: {
        mode: "offer_prices_backfill", cursor_listing_id: null,
        initial_current_listings: total, failure_count: 0, failed_items: [],
        snapshots_inserted_total: 0, enqueued_at: new Date().toISOString(),
      },
    });
    const status: Result["status"] = insertError ? insertError.code === "23505" ? "already_running" : "failed" : "queued";
    return { accountCode: account.code, accountName: account.display_name, currentListings: total, status };
  }));

  return NextResponse.json({
    ok: true,
    results,
    summary: {
      accounts: results.length,
      queued: results.filter((result) => result.status === "queued").length,
      alreadyRunning: results.filter((result) => result.status === "already_running").length,
      failed: results.filter((result) => result.status === "failed").length,
      listings: results.reduce((total, result) => total + result.currentListings, 0),
    },
  });
}
