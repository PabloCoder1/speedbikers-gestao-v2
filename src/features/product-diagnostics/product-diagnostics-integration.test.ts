import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { createClient } from "@supabase/supabase-js";

/*
 * Integration test against production credentials for the ETAPA 35 SQL
 * layer (get_product_diagnostic_evidence RPC, the widened
 * get_purchase_planning_signal_for_sku, and the product_diagnostic_runs
 * table's running-lock + cache-lookup mechanics). Gated on
 * NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY (skips silently without
 * them) — run explicitly via
 * `npx tsx --env-file=.env.local --conditions=react-server --test <this file>`.
 * The business-logic tests (25 required scenarios) live in
 * product-diagnostic-domain.test.ts, product-diagnostic-permissions.test.ts
 * and run-product-diagnostic.test.ts and use a mocked Anthropic adapter —
 * this file never calls the real Anthropic API either.
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

  const slug = `fixture-diag-${randomUUID().slice(0, 8)}`;
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .insert({ name: `Fixture Diagnostics ${slug}`, slug })
    .select("id")
    .single();
  if (orgError || !org) throw new Error(`failed to create fixture organization: ${orgError?.message}`);
  organizationId = org.id;

  const { data: members, error: memberLookupError } = await admin
    .from("organization_members")
    .select("user_id")
    .eq("is_active", true)
    .limit(1);
  if (memberLookupError || !members?.length) throw new Error(`failed to borrow a real user id: ${memberLookupError?.message}`);
  actorUserId = members[0].user_id;
  const { error: memberError } = await admin
    .from("organization_members")
    .insert({ organization_id: organizationId, user_id: actorUserId, role: "admin", is_active: true });
  if (memberError) throw new Error(`failed to add fixture member: ${memberError.message}`);

  const { data: product, error: productError } = await admin
    .from("products")
    .insert({ organization_id: organizationId, sku: "FIXTURE-SKU", sku_key: "FIXTURE-SKU", name: "Fixture product" })
    .select("id")
    .single();
  if (productError || !product) throw new Error(`failed to create fixture product: ${productError?.message}`);
  productId = product.id;
});

after(async () => {
  if (!hasCredentials) return;
  await admin.from("organizations").delete().eq("id", organizationId);
});

test("get_product_diagnostic_evidence returns a well-formed evidence object for a product with no data", { skip: !hasCredentials }, async () => {
  const { data, error } = await admin.rpc("get_product_diagnostic_evidence", {
    target_organization_id: organizationId,
    target_product_id: productId,
    as_of_date: "2026-08-18",
  });
  assert.equal(error, null, error?.message);
  assert.equal(data.mappingStatus, "missing");
  assert.equal(data.sourceSkuKey, null);
  assert.equal(data.sales.units7, 0);
  assert.deepEqual(data.priceEvents, []);
  assert.deepEqual(data.fullEvents, []);
  assert.deepEqual(data.alerts, []);
  assert.deepEqual(data.openPurchaseOrders, []);
});

test("get_purchase_planning_signal_for_sku returns null for a sku with no planning signal", { skip: !hasCredentials }, async () => {
  const { data, error } = await admin.rpc("get_purchase_planning_signal_for_sku", {
    target_organization_id: organizationId,
    target_source_sku_key: `nonexistent-${randomUUID()}`,
  });
  assert.equal(error, null, error?.message);
  assert.equal(data, null);
});

test("a second concurrent 'running' insert for the same product is rejected by the lock index", { skip: !hasCredentials }, async () => {
  const runBase = {
    organization_id: organizationId,
    product_id: productId,
    requested_by: actorUserId,
    status: "running",
    diagnostic_trigger: "manual",
    evidence_version: "product-evidence-v1",
    evidence_hash: "hash-a",
    prompt_version: "product-diagnostic-v1",
    model: "claude-sonnet-5",
    evidence: [],
  };

  const first = await admin.from("product_diagnostic_runs").insert(runBase).select("id").single();
  assert.equal(first.error, null, first.error?.message);

  const second = await admin.from("product_diagnostic_runs").insert({ ...runBase, evidence_hash: "hash-b" }).select("id").single();
  assert.ok(second.error, "expected the second concurrent running insert to fail");
  assert.equal(second.error.code, "23505");

  await admin.from("product_diagnostic_runs").update({ status: "succeeded", completed_at: new Date().toISOString() }).eq("id", first.data.id);
});

test("a succeeded run is found by the cache lookup filters (org, product, hash, prompt, model)", { skip: !hasCredentials }, async () => {
  const hash = `cache-hash-${randomUUID()}`;
  const inserted = await admin
    .from("product_diagnostic_runs")
    .insert({
      organization_id: organizationId,
      product_id: productId,
      requested_by: actorUserId,
      status: "succeeded",
      diagnostic_trigger: "manual",
      evidence_version: "product-evidence-v1",
      evidence_hash: hash,
      prompt_version: "product-diagnostic-v1",
      model: "claude-sonnet-5",
      evidence: [],
      result: { verdict: "stable" },
      completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  assert.equal(inserted.error, null, inserted.error?.message);

  const cached = await admin
    .from("product_diagnostic_runs")
    .select("id,status")
    .eq("organization_id", organizationId)
    .eq("product_id", productId)
    .eq("evidence_hash", hash)
    .eq("prompt_version", "product-diagnostic-v1")
    .eq("model", "claude-sonnet-5")
    .eq("status", "succeeded")
    .maybeSingle();
  assert.equal(cached.error, null, cached.error?.message);
  assert.equal(cached.data?.id, inserted.data.id);
});
