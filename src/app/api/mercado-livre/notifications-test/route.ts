import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { ingestMercadoLivreNotification } from "@/features/ml-sync/ingest-mercado-livre-notification";
import {
  getMercadoLivreConfig,
  isMercadoLivreAppCode,
} from "@/integrations/mercado-livre/config";
import { createAdminClient } from "@/lib/supabase/admin";

type AccountRow = {
  id: string;
  code: string;
  seller_id: string | null;
  oauth_app_code: string;
  connection_status: string;
};

export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!access) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  if (access.role !== "admin") {
    return NextResponse.json({ error: "not_authorized" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  const accountCode = typeof input.account === "string" ? input.account.trim() : "";
  const itemId = typeof input.item === "string" ? input.item.trim().toUpperCase() : "";
  const topic = input.topic === undefined ? "items_prices" : input.topic;
  const offerId = typeof input.offer === "string" ? input.offer.trim().toUpperCase() : "";
  if (
    !accountCode ||
    !/^MLB[0-9]+$/.test(itemId) ||
    (topic !== "items_prices" && topic !== "public_offers")
  ) {
    return NextResponse.json({ error: "invalid_target" }, { status: 400 });
  }
  const offerItemId = offerId.match(/^OFFER-(MLB[0-9]+)-/)?.[1] ?? null;
  if (topic === "public_offers" && (!offerItemId || offerItemId !== itemId)) {
    return NextResponse.json({ error: "invalid_offer" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: account, error: accountError } = await admin
    .from("ml_accounts")
    .select("id,code,seller_id,oauth_app_code,connection_status")
    .eq("organization_id", access.organizationId)
    .eq("code", accountCode)
    .eq("is_active", true)
    .maybeSingle<AccountRow>();
  if (accountError || !account) {
    return NextResponse.json({ error: "account_not_found" }, { status: 404 });
  }
  if (
    account.connection_status !== "connected" ||
    !account.seller_id ||
    !isMercadoLivreAppCode(account.oauth_app_code)
  ) {
    return NextResponse.json({ error: "account_not_connected" }, { status: 409 });
  }

  const { data: listing, error: listingError } = await admin
    .from("ml_listings")
    .select("id")
    .eq("organization_id", access.organizationId)
    .eq("ml_account_id", account.id)
    .eq("item_id", itemId)
    .eq("is_current", true)
    .maybeSingle<{ id: string }>();
  if (listingError || !listing) {
    return NextResponse.json({ error: "listing_not_current" }, { status: 404 });
  }

  const notificationTestId = `TEST-${randomUUID()}`;
  const config = getMercadoLivreConfig();
  const rawBody = JSON.stringify({
    topic,
    resource: topic === "items_prices"
      ? `/items/${itemId}`
      : `/seller-promotions/offers/${offerId}`,
    user_id: account.seller_id,
    application_id: config.apps[account.oauth_app_code].clientId,
    _id: notificationTestId,
    sent: new Date().toISOString(),
    attempts: 1,
  });

  try {
    const enqueueResult = await ingestMercadoLivreNotification({ rawBody });
    return NextResponse.json({ ok: true, enqueueResult, notificationTestId });
  } catch (error) {
    console.error(
      "Mercado Livre notification test failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json({ error: "notification_test_failed" }, { status: 500 });
  }
}
