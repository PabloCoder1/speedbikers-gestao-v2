import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { createClient } from "@supabase/supabase-js";

/*
 * Integration test against production credentials for the ETAPA 36 job
 * queue (product_diagnostic_jobs) and market research cache
 * (product_market_research_runs). Gated on NEXT_PUBLIC_SUPABASE_URL /
 * SUPABASE_SECRET_KEY (skips silently without them) — run explicitly via
 * `npx tsx --env-file=.env.local --conditions=react-server --test <this file>`.
 * Never calls the real Anthropic API or the real Mercado Livre API.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = any;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
const hasCredentials = Boolean(supabaseUrl && supabaseSecretKey);

let admin: AdminClient;
let organizationId: string;
let productId: string;
let actorUserId: string;

before(async () => {
  if (!hasCredentials) return;
  admin = createClient(supabaseUrl as string, supabaseSecretKey as string, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  const slug = `fixture-diagjobs-${randomUUID().slice(0, 8)}`;
  const { data: org, error: orgError } = await admin.from("organizations").insert({ name: `Fixture Diag Jobs ${slug}`, slug }).select("id").single();
  if (orgError || !org) throw new Error(`failed to create fixture organization: ${orgError?.message}`);
  organizationId = org.id;

  const { data: members, error: memberLookupError } = await admin.from("organization_members").select("user_id").eq("is_active", true).limit(1);
  if (memberLookupError || !members?.length) throw new Error(`failed to borrow a real user id: ${memberLookupError?.message}`);
  actorUserId = members[0].user_id;
  const { error: memberError } = await admin.from("organization_members").insert({ organization_id: organizationId, user_id: actorUserId, role: "admin", is_active: true });
  if (memberError) throw new Error(`failed to add fixture member: ${memberError.message}`);

  const { data: product, error: productError } = await admin.from("products").insert({ organization_id: organizationId, sku: "FIXTURE-JOB-SKU", sku_key: "FIXTURE-JOB-SKU", name: "Fixture job product" }).select("id").single();
  if (productError || !product) throw new Error(`failed to create fixture product: ${productError?.message}`);
  productId = product.id;
});

after(async () => {
  if (!hasCredentials) return;
  await admin.from("organizations").delete().eq("id", organizationId);
});

// 28. double click => um active job
test("a second job insert for the same product while one is queued/running is rejected by the active-job unique index", { skip: !hasCredentials }, async () => {
  const first = await admin.from("product_diagnostic_jobs").insert({ organization_id: organizationId, product_id: productId, requested_by: actorUserId, force: false }).select("id").single();
  assert.equal(first.error, null, first.error?.message);

  const second = await admin.from("product_diagnostic_jobs").insert({ organization_id: organizationId, product_id: productId, requested_by: actorUserId, force: false }).select("id").single();
  assert.ok(second.error, "expected the second concurrent job insert to fail");
  assert.equal(second.error.code, "23505");

  await admin.from("product_diagnostic_jobs").update({ status: "succeeded", completed_at: new Date().toISOString() }).eq("id", first.data.id);
});

test("claim_next_product_diagnostic_job claims a queued job and increments attempt_count", { skip: !hasCredentials }, async () => {
  const inserted = await admin.from("product_diagnostic_jobs").insert({ organization_id: organizationId, product_id: productId, requested_by: actorUserId, force: false }).select("id").single();
  assert.equal(inserted.error, null, inserted.error?.message);

  const claimed = await admin.rpc("claim_next_product_diagnostic_job", { requested_lease_id: randomUUID(), lease_duration_seconds: 120 });
  assert.equal(claimed.error, null, claimed.error?.message);
  assert.equal(claimed.data, inserted.data.id);

  const row = await admin.from("product_diagnostic_jobs").select("status,attempt_count").eq("id", inserted.data.id).single();
  assert.equal(row.data.status, "running");
  assert.equal(row.data.attempt_count, 1);

  await admin.from("product_diagnostic_jobs").update({ status: "succeeded", completed_at: new Date().toISOString() }).eq("id", inserted.data.id);
});

// 25. official market cache hit
test("a fresh product_market_research_runs row (kind=official_ml) is found within its TTL", { skip: !hasCredentials }, async () => {
  const expiresAt = new Date(Date.now() + 45 * 60 * 1000).toISOString();
  const inserted = await admin.from("product_market_research_runs").insert({ organization_id: organizationId, product_id: productId, kind: "official_ml", status: "succeeded", data: { priceToWin: [] }, expires_at: expiresAt }).select("id").single();
  assert.equal(inserted.error, null, inserted.error?.message);

  const cached = await admin
    .from("product_market_research_runs")
    .select("id,data")
    .eq("organization_id", organizationId).eq("product_id", productId).eq("kind", "official_ml").eq("status", "succeeded")
    .gt("expires_at", new Date().toISOString())
    .order("fetched_at", { ascending: false }).limit(1).maybeSingle();
  assert.equal(cached.error, null, cached.error?.message);
  assert.equal(cached.data?.id, inserted.data.id);
});

// 26. web research cache hit
test("a fresh product_market_research_runs row (kind=external_web) is found within its TTL", { skip: !hasCredentials }, async () => {
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const inserted = await admin.from("product_market_research_runs").insert({ organization_id: organizationId, product_id: productId, kind: "external_web", status: "succeeded", data: { externalResults: [], summary: "x" }, expires_at: expiresAt }).select("id").single();
  assert.equal(inserted.error, null, inserted.error?.message);

  const cached = await admin
    .from("product_market_research_runs")
    .select("id")
    .eq("organization_id", organizationId).eq("product_id", productId).eq("kind", "external_web").eq("status", "succeeded")
    .gt("expires_at", new Date().toISOString())
    .order("fetched_at", { ascending: false }).limit(1).maybeSingle();
  assert.equal(cached.error, null, cached.error?.message);
  assert.equal(cached.data?.id, inserted.data.id);
});

test("an expired product_market_research_runs row is not returned as a cache hit", { skip: !hasCredentials }, async () => {
  // Uses its own fixture product so an earlier test's still-fresh
  // official_ml row (same organization) can never be found instead and
  // mask a real regression here.
  const { data: freshProduct, error: freshProductError } = await admin
    .from("products")
    .insert({ organization_id: organizationId, sku: "FIXTURE-EXPIRED-CACHE", sku_key: "FIXTURE-EXPIRED-CACHE", name: "Fixture expired-cache product" })
    .select("id")
    .single();
  assert.equal(freshProductError, null, freshProductError?.message);

  const expiredAt = new Date(Date.now() - 1000).toISOString();
  const inserted = await admin.from("product_market_research_runs").insert({ organization_id: organizationId, product_id: freshProduct.id, kind: "official_ml", status: "succeeded", data: {}, expires_at: expiredAt }).select("id").single();
  assert.equal(inserted.error, null, inserted.error?.message);

  const cached = await admin
    .from("product_market_research_runs")
    .select("id")
    .eq("organization_id", organizationId).eq("product_id", freshProduct.id).eq("kind", "official_ml").eq("status", "succeeded")
    .gt("expires_at", new Date().toISOString())
    .order("fetched_at", { ascending: false }).limit(1).maybeSingle();
  assert.equal(cached.error, null, cached.error?.message);
  assert.equal(cached.data, null);
});
