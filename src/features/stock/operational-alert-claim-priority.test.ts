import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = any;

/*
 * Integration test against production credentials — same constraint
 * as purchase-planning-equivalence.test.ts (no local Postgres in this
 * repo). Skips silently without credentials.
 *
 * Exercises the real claim_next_operational_alert_job RPC end to end
 * against temporary, self-created products (never touching real
 * business data): each job needs its own product because the partial
 * unique index only allows one active job per (organization_id,
 * product_id). Cleanup deletes the temp products, which cascades away
 * the job rows (operational_alert_jobs FK is ON DELETE CASCADE).
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
const hasCredentials = Boolean(supabaseUrl && supabaseSecretKey);

async function createTempProduct(
  admin: AdminClient,
  organizationId: string,
) {
  const skuKey = `__HOTFIX_TEST_${randomUUID()}`.toUpperCase();
  const { data, error } = await admin
    .from("products")
    .insert({
      organization_id: organizationId,
      sku: skuKey,
      sku_key: skuKey,
      name: "hotfix claim priority test product",
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`failed to create temp product: ${error?.message}`);
  }

  return data.id as string;
}

test(
  "claim escolhe job de evento antes de periodic_reconcile, mesmo com next_attempt_at mais recente",
  { skip: !hasCredentials },
  async (t) => {
    const admin = createClient(supabaseUrl as string, supabaseSecretKey as string, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });

    const { data: organization, error: organizationError } = await admin
      .from("organizations")
      .select("id")
      .eq("slug", "speed-bikers")
      .single();
    assert.equal(organizationError, null);
    assert.ok(organization);

    const eventProductId = await createTempProduct(admin, organization.id);
    const periodicProductId = await createTempProduct(admin, organization.id);

    t.after(async () => {
      await admin.from("products").delete().in("id", [eventProductId, periodicProductId]);
    });

    const now = Date.now();

    // Periodic job is OLDER (would win on next_attempt_at alone) —
    // the priority fix must still pick the event job first.
    const { error: periodicInsertError } = await admin.from("operational_alert_jobs").insert({
      organization_id: organization.id,
      product_id: periodicProductId,
      reason: "periodic_reconcile",
      next_attempt_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(periodicInsertError, null);

    const { error: eventInsertError } = await admin.from("operational_alert_jobs").insert({
      organization_id: organization.id,
      product_id: eventProductId,
      reason: "manual_inventory_link_set",
      next_attempt_at: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(eventInsertError, null);

    const leaseId1 = randomUUID();
    const { data: firstClaimedId, error: firstClaimError } = await admin.rpc(
      "claim_next_operational_alert_job",
      { requested_lease_id: leaseId1 },
    );
    assert.equal(firstClaimError, null);

    const { data: firstClaimedJob } = await admin
      .from("operational_alert_jobs")
      .select("product_id")
      .eq("id", firstClaimedId)
      .single();

    assert.equal(
      firstClaimedJob?.product_id,
      eventProductId,
      "o job de evento deveria ser reivindicado primeiro, apesar do periodic_reconcile ser mais antigo",
    );

    const leaseId2 = randomUUID();
    const { data: secondClaimedId } = await admin.rpc("claim_next_operational_alert_job", {
      requested_lease_id: leaseId2,
    });
    const { data: secondClaimedJob } = await admin
      .from("operational_alert_jobs")
      .select("product_id")
      .eq("id", secondClaimedId)
      .single();

    assert.equal(secondClaimedJob?.product_id, periodicProductId);
  },
);

test(
  "dentro da mesma prioridade, o desempate é determinístico (next_attempt_at, created_at, id)",
  { skip: !hasCredentials },
  async (t) => {
    const admin = createClient(supabaseUrl as string, supabaseSecretKey as string, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });

    const { data: organization } = await admin
      .from("organizations")
      .select("id")
      .eq("slug", "speed-bikers")
      .single();
    assert.ok(organization);

    const productA = await createTempProduct(admin, organization.id);
    const productB = await createTempProduct(admin, organization.id);

    t.after(async () => {
      await admin.from("products").delete().in("id", [productA, productB]);
    });

    // Same next_attempt_at for both, same statement so created_at is
    // identical too (now() is transaction-stable in Postgres) — the
    // only remaining tie-breaker is `id`, compared ascending.
    const sameNextAttemptAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const { data: insertedJobs, error: insertError } = await admin
      .from("operational_alert_jobs")
      .insert([
        {
          organization_id: organization.id,
          product_id: productA,
          reason: "periodic_reconcile",
          next_attempt_at: sameNextAttemptAt,
        },
        {
          organization_id: organization.id,
          product_id: productB,
          reason: "periodic_reconcile",
          next_attempt_at: sameNextAttemptAt,
        },
      ])
      .select("id, product_id");
    assert.equal(insertError, null);
    assert.equal(insertedJobs?.length, 2);

    const expectedOrder = [...(insertedJobs ?? [])].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );

    const claimedOrder: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { data: claimedId } = await admin.rpc("claim_next_operational_alert_job", {
        requested_lease_id: randomUUID(),
      });
      const { data: claimedJob } = await admin
        .from("operational_alert_jobs")
        .select("product_id")
        .eq("id", claimedId)
        .single();
      if (claimedJob?.product_id) {
        claimedOrder.push(claimedJob.product_id);
      }
    }

    assert.deepEqual(claimedOrder, expectedOrder.map((job) => job.product_id));
  },
);
