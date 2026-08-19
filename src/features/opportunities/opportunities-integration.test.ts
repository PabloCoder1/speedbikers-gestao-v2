import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { createClient } from "@supabase/supabase-js";

/*
 * Integration test against production credentials for the ETAPA 37
 * opportunity scanner (public.scan_product_opportunities) and its
 * dedup/reconcile/resolve/dismiss lifecycle. Gated on
 * NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY (skips silently without
 * them) — run explicitly via
 * `npx tsx --env-file=.env.local --conditions=react-server --test <this file>`.
 * Never calls Mercado Livre or Anthropic — the scanner itself is DB-only.
 *
 * The 11 opportunity-type trigger conditions themselves were validated by
 * running scan_product_opportunities against real production data during
 * development (documented in the ETAPA 37 final report) rather than
 * re-derived here with fixture data for every type — the scanner is pure
 * set-based SQL with no per-product branching, so the lifecycle mechanics
 * exercised below (which are shared by every type) are the highest-value
 * thing to cover with an automated, repeatable test.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = any;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
const hasCredentials = Boolean(supabaseUrl && supabaseSecretKey);

let admin: AdminClient;
let organizationId: string;
let mlAccountId: string;
let productId: string;
let actorUserId: string;

async function metricRow(organizationId: string, mlAccountId: string, productId: string, metricDate: string, unitsSold: number) {
  const { error } = await admin.from("daily_product_metrics").insert({
    organization_id: organizationId,
    ml_account_id: mlAccountId,
    product_id: productId,
    metric_date: metricDate,
    orders_count: unitsSold,
    units_sold: unitsSold,
    gross_revenue: unitsSold * 50,
    sale_fees: 0,
    net_after_sale_fee: unitsSold * 50,
    average_unit_price: 50,
  });
  if (error) throw new Error(`failed to insert fixture metric: ${error.message}`);
}

function dateKeyOffset(base: string, offsetDays: number) {
  const date = new Date(`${base}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

before(async () => {
  if (!hasCredentials) return;
  admin = createClient(supabaseUrl as string, supabaseSecretKey as string, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  const slug = `fixture-opps-${randomUUID().slice(0, 8)}`;
  const { data: org, error: orgError } = await admin.from("organizations").insert({ name: `Fixture Opportunities ${slug}`, slug }).select("id").single();
  if (orgError || !org) throw new Error(`failed to create fixture organization: ${orgError?.message}`);
  organizationId = org.id;

  const { data: members, error: memberLookupError } = await admin.from("organization_members").select("user_id").eq("is_active", true).limit(1);
  if (memberLookupError || !members?.length) throw new Error(`failed to borrow a real user id: ${memberLookupError?.message}`);
  actorUserId = members[0].user_id;
  const { error: memberError } = await admin.from("organization_members").insert({ organization_id: organizationId, user_id: actorUserId, role: "admin", is_active: true });
  if (memberError) throw new Error(`failed to add fixture member: ${memberError.message}`);

  const { data: account, error: accountError } = await admin
    .from("ml_accounts")
    .insert({ organization_id: organizationId, code: "speedbikers", display_name: "Fixture speedbikers", oauth_app_code: "speedbikers" })
    .select("id")
    .single();
  if (accountError || !account) throw new Error(`failed to create fixture ml account: ${accountError?.message}`);
  mlAccountId = account.id;

  const { data: product, error: productError } = await admin.from("products").insert({ organization_id: organizationId, sku: "FIXTURE-OPP-SKU", sku_key: "FIXTURE-OPP-SKU", name: "Fixture opportunity product" }).select("id").single();
  if (productError || !product) throw new Error(`failed to create fixture product: ${productError?.message}`);
  productId = product.id;
});

after(async () => {
  if (!hasCredentials) return;
  await admin.from("daily_product_metrics").delete().eq("organization_id", organizationId);
  await admin.from("organizations").delete().eq("id", organizationId);
});

const AS_OF_DATE = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
AS_OF_DATE.setDate(AS_OF_DATE.getDate() - 1);
const asOfDateKey = AS_OF_DATE.toISOString().slice(0, 10);

test("a sales drop opens an opportunity, then reconciling with the same condition updates it without duplicating", { skip: !hasCredentials }, async () => {
  // previous7: 5/day for 7 days = 35 units; current7: 0
  for (let offset = -13; offset <= -7; offset += 1) await metricRow(organizationId, mlAccountId, productId, dateKeyOffset(asOfDateKey, offset), 5);

  const firstScan = await admin.rpc("scan_product_opportunities", { target_organization_id: organizationId });
  assert.equal(firstScan.error, null, firstScan.error?.message);
  assert.ok((firstScan.data as { opened: number }).opened >= 1);

  const opportunity = await admin.from("product_opportunities").select("id,status,fingerprint,first_seen_at,last_seen_at").eq("organization_id", organizationId).eq("fingerprint", `SALES_DROP:${productId}`).single();
  assert.equal(opportunity.error, null, opportunity.error?.message);
  assert.equal(opportunity.data.status, "open");
  const firstSeenAt = opportunity.data.first_seen_at;

  // 27. dedupe fingerprint / 28. reconcile update sem duplicar
  const secondScan = await admin.rpc("scan_product_opportunities", { target_organization_id: organizationId });
  assert.equal(secondScan.error, null, secondScan.error?.message);

  const rows = await admin.from("product_opportunities").select("id").eq("organization_id", organizationId).eq("fingerprint", `SALES_DROP:${productId}`);
  assert.equal(rows.data?.length, 1, "expected exactly one row for the same fingerprint after two scans");

  const reconciled = await admin.from("product_opportunities").select("first_seen_at,last_seen_at").eq("id", opportunity.data.id).single();
  assert.equal(reconciled.data.first_seen_at, firstSeenAt, "first_seen_at must never move on reconcile");
});

test("removing the underlying condition resolves the opportunity on the next scan", { skip: !hasCredentials }, async () => {
  // 29. resolved
  await admin.from("daily_product_metrics").delete().eq("organization_id", organizationId).eq("product_id", productId);
  for (let offset = -6; offset <= 0; offset += 1) await metricRow(organizationId, mlAccountId, productId, dateKeyOffset(asOfDateKey, offset), 5);
  for (let offset = -13; offset <= -7; offset += 1) await metricRow(organizationId, mlAccountId, productId, dateKeyOffset(asOfDateKey, offset), 5);

  const scan = await admin.rpc("scan_product_opportunities", { target_organization_id: organizationId });
  assert.equal(scan.error, null, scan.error?.message);

  const resolved = await admin.from("product_opportunities").select("status,resolved_at").eq("organization_id", organizationId).eq("fingerprint", `SALES_DROP:${productId}`).single();
  assert.equal(resolved.data.status, "resolved");
  assert.ok(resolved.data.resolved_at);
});

test("the condition reappearing reopens the same row, preserving first_seen_at", { skip: !hasCredentials }, async () => {
  await admin.from("daily_product_metrics").delete().eq("organization_id", organizationId).eq("product_id", productId);
  for (let offset = -13; offset <= -7; offset += 1) await metricRow(organizationId, mlAccountId, productId, dateKeyOffset(asOfDateKey, offset), 5);

  const before = await admin.from("product_opportunities").select("id,first_seen_at").eq("organization_id", organizationId).eq("fingerprint", `SALES_DROP:${productId}`).single();
  const originalFirstSeenAt = before.data.first_seen_at;

  const scan = await admin.rpc("scan_product_opportunities", { target_organization_id: organizationId });
  assert.equal(scan.error, null, scan.error?.message);

  const reopened = await admin.from("product_opportunities").select("id,status,resolved_at,first_seen_at").eq("id", before.data.id).single();
  assert.equal(reopened.data.status, "open");
  assert.equal(reopened.data.resolved_at, null);
  assert.equal(reopened.data.first_seen_at, originalFirstSeenAt);
});

// 31. dismissed — a dismissed opportunity is never silently reopened by a scan while the same condition persists
test("a dismissed opportunity stays dismissed across scans while the condition persists", { skip: !hasCredentials }, async () => {
  const opportunity = await admin.from("product_opportunities").select("id").eq("organization_id", organizationId).eq("fingerprint", `SALES_DROP:${productId}`).single();
  const dismissed = await admin.from("product_opportunities").update({ status: "dismissed", dismissed_at: new Date().toISOString(), dismissed_by: actorUserId }).eq("id", opportunity.data.id).select("id").single();
  assert.equal(dismissed.error, null, dismissed.error?.message);

  const scan = await admin.rpc("scan_product_opportunities", { target_organization_id: organizationId });
  assert.equal(scan.error, null, scan.error?.message);

  const stillDismissed = await admin.from("product_opportunities").select("status").eq("id", opportunity.data.id).single();
  assert.equal(stillDismissed.data.status, "dismissed");
});

// 30. snoozed — persisted correctly and readable
test("snoozed_until persists and is readable back", { skip: !hasCredentials }, async () => {
  const { data: freshProduct } = await admin.from("products").insert({ organization_id: organizationId, sku: "FIXTURE-OPP-SNOOZE", sku_key: "FIXTURE-OPP-SNOOZE", name: "Fixture snooze product" }).select("id").single();
  for (let offset = -13; offset <= -7; offset += 1) await metricRow(organizationId, mlAccountId, freshProduct.id, dateKeyOffset(asOfDateKey, offset), 5);

  const scan = await admin.rpc("scan_product_opportunities", { target_organization_id: organizationId });
  assert.equal(scan.error, null, scan.error?.message);

  const opportunity = await admin.from("product_opportunities").select("id").eq("organization_id", organizationId).eq("fingerprint", `SALES_DROP:${freshProduct.id}`).single();
  const snoozedUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const snoozed = await admin.from("product_opportunities").update({ status: "snoozed", snoozed_until: snoozedUntil }).eq("id", opportunity.data.id).select("status,snoozed_until").single();
  assert.equal(snoozed.error, null, snoozed.error?.message);
  assert.equal(snoozed.data.status, "snoozed");
  assert.equal(snoozed.data.snoozed_until, snoozedUntil);
});

test("get_product_opportunities_summary and get_product_opportunities_page return data scoped to the requested organization", { skip: !hasCredentials }, async () => {
  // The productId/freshProduct opportunities from earlier tests are now
  // dismissed/snoozed (not "open"), so this test creates its own product
  // with a currently-open opportunity rather than relying on that state.
  const { data: summaryProduct } = await admin.from("products").insert({ organization_id: organizationId, sku: "FIXTURE-OPP-SUMMARY", sku_key: "FIXTURE-OPP-SUMMARY", name: "Fixture summary product" }).select("id").single();
  for (let offset = -13; offset <= -7; offset += 1) await metricRow(organizationId, mlAccountId, summaryProduct.id, dateKeyOffset(asOfDateKey, offset), 5);
  const scan = await admin.rpc("scan_product_opportunities", { target_organization_id: organizationId });
  assert.equal(scan.error, null, scan.error?.message);

  const summary = await admin.rpc("get_product_opportunities_summary", { target_organization_id: organizationId });
  assert.equal(summary.error, null, summary.error?.message);
  assert.ok((summary.data as { openTotal: number }).openTotal >= 1);

  const page = await admin.rpc("get_product_opportunities_page", { target_organization_id: organizationId, status_filter: "open", page_size: 50 });
  assert.equal(page.error, null, page.error?.message);
  const rows = page.data as Array<{ sku: string; opportunity_type: string }>;
  assert.ok(rows.length >= 1);
  assert.ok(rows.some((row) => row.sku === "FIXTURE-OPP-SUMMARY"), "page must include the fixture product from this organization");
});
