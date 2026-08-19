import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = any;

/*
 * Integration test against production credentials — same constraint
 * as purchase-planning-equivalence.test.ts. Skips silently without
 * credentials. Every fixture row is created and deleted within this
 * test (never persisted), verifying the effective-transit
 * reconciliation added in M3 against the real
 * get_purchase_planning_signals via the get_purchase_planning_signal_for_sku
 * test helper (M2b).
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
const hasCredentials = Boolean(supabaseUrl && supabaseSecretKey);

function hex64() {
  return (randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 64);
}

async function createFixtureProduct(admin: AdminClient, organizationId: string, skuKey: string) {
  const { data, error } = await admin
    .from("products")
    .insert({ organization_id: organizationId, sku: skuKey, sku_key: skuKey, name: "fixture planning integration" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`failed to create fixture product: ${error?.message}`);
  return data.id as string;
}

async function linkProduct(
  admin: AdminClient,
  organizationId: string,
  productId: string,
  skuKey: string,
) {
  const { error } = await admin.from("product_inventory_links").insert({
    organization_id: organizationId,
    product_id: productId,
    source: "upseller",
    source_sku: skuKey,
    source_sku_key: skuKey,
    source_kind: "simple",
    link_method: "manual",
    confidence: "manual",
    is_active: true,
  });
  if (error) throw new Error(`failed to create fixture link: ${error.message}`);
}

async function createFixturePurchaseOrder(
  admin: AdminClient,
  organizationId: string,
  userId: string,
  skuKey: string,
  {
    status,
    transitAccountingSource = "internal",
    quantityOrdered,
    cancelledQuantity = 0,
    receivedQuantity = 0,
  }: {
    status: string;
    transitAccountingSource?: string;
    quantityOrdered: number;
    cancelledQuantity?: number;
    receivedQuantity?: number;
  },
) {
  const { data: po, error: poError } = await admin
    .from("purchase_orders")
    .insert({
      organization_id: organizationId,
      status,
      transit_accounting_source: transitAccountingSource,
      created_by: userId,
    })
    .select("id")
    .single();
  if (poError || !po) throw new Error(`failed to create fixture PO: ${poError?.message}`);

  const { data: item, error: itemError } = await admin
    .from("purchase_order_items")
    .insert({
      organization_id: organizationId,
      purchase_order_id: po.id,
      source_sku: skuKey,
      source_sku_key: skuKey,
      quantity_ordered: quantityOrdered,
      cancelled_quantity: cancelledQuantity,
    })
    .select("id")
    .single();
  if (itemError || !item) throw new Error(`failed to create fixture PO item: ${itemError?.message}`);

  if (receivedQuantity > 0) {
    // Minimal stock_receipt + item to make purchase_order_item_progress
    // report receivedQuantity, without going through the NF-e RPC.
    const { data: receipt, error: receiptError } = await admin
      .from("stock_receipts")
      .insert({
        organization_id: organizationId,
        access_key: String(Math.floor(Math.random() * 1e13)).padStart(44, "0"),
        invoice_number: "FIXTURE",
        source_sha256: hex64(),
        destination_warehouse_name: "Fixture WH",
        destination_warehouse_key: "FIXTURE-WH",
        received_by: userId,
        purchase_order_id: po.id,
      })
      .select("id")
      .single();
    if (receiptError || !receipt) throw new Error(`failed to create fixture receipt: ${receiptError?.message}`);

    const { error: receiptItemError } = await admin.from("stock_receipt_items").insert({
      organization_id: organizationId,
      receipt_id: receipt.id,
      line_number: 1,
      source_sku: skuKey,
      sku_key: skuKey,
      quantity: receivedQuantity,
      baseline_import_id: await ensureFixtureImportBatch(admin, organizationId),
      purchase_order_item_id: item.id,
    });
    if (receiptItemError) throw new Error(`failed to create fixture receipt item: ${receiptItemError.message}`);
  }

  return po.id as string;
}

let cachedImportBatchId: string | null = null;
async function ensureFixtureImportBatch(admin: AdminClient, organizationId: string) {
  if (cachedImportBatchId) return cachedImportBatchId;
  const { data, error } = await admin
    .from("upseller_import_batches")
    .insert({ organization_id: organizationId, status: "applied", import_fingerprint: hex64() })
    .select("id")
    .single();
  if (error || !data) throw new Error(`failed to create fixture import batch: ${error?.message}`);
  cachedImportBatchId = data.id as string;
  return cachedImportBatchId;
}

async function cleanupPurchaseOrders(admin: AdminClient, purchaseOrderIds: string[]) {
  if (purchaseOrderIds.length === 0) return;
  const { data: receipts } = await admin
    .from("stock_receipts")
    .select("id")
    .in("purchase_order_id", purchaseOrderIds);
  const receiptIds = (receipts ?? []).map((r: { id: string }) => r.id);
  if (receiptIds.length > 0) {
    await admin.from("stock_receipt_items").delete().in("receipt_id", receiptIds);
    await admin.from("stock_receipts").delete().in("id", receiptIds);
  }
  await admin.from("purchase_order_items").delete().in("purchase_order_id", purchaseOrderIds);
  const { error } = await admin.from("purchase_orders").delete().in("id", purchaseOrderIds);
  assert.equal(error, null, "cleanup of fixture purchase orders must succeed");
}

test(
  "cenários 1-2 — UpSeller transit + pedido interno soma; upseller_confirmed não soma de novo",
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

    const { data: anyMember } = await admin
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", organization.id)
      .limit(1)
      .single();
    assert.ok(anyMember, "esperava ao menos um membro na organização para usar como actor_user_id");

    const skuKey = `__FIXTURE_PLANNING_${randomUUID()}`.toUpperCase();
    const productId = await createFixtureProduct(admin, organization.id, skuKey);
    const importBatchId = await ensureFixtureImportBatch(admin, organization.id);
    const purchaseOrderIds: string[] = [];

    t.after(async () => {
      await cleanupPurchaseOrders(admin, purchaseOrderIds);
      await admin.from("product_inventory_links").delete().eq("product_id", productId);
      await admin.from("upseller_stock_states").delete().eq("organization_id", organization.id).eq("sku_key", skuKey);
      await admin.from("products").delete().eq("id", productId);
      await admin.from("upseller_import_batches").delete().eq("id", importBatchId);
      cachedImportBatchId = null; // avoid leaking this test's batch id into the next test in this file
    });

    await linkProduct(admin, organization.id, productId, skuKey);

    const { error: stateError } = await admin.from("upseller_stock_states").insert({
      organization_id: organization.id,
      source_sku: skuKey,
      sku_key: skuKey,
      warehouse_name: "Fixture WH",
      warehouse_key: "FIXTURE-WH",
      low_stock_threshold: 0,
      purchase_in_transit: 20,
      transfer_in_transit: 0,
      occupied_quantity: 0,
      available_quantity: 0,
      current_quantity: 0,
      state_hash: hex64(),
      source_import_id: importBatchId,
    });
    assert.equal(stateError, null);

    // Cenário 1 — internal: UpSeller 20 + interno 30 => efetivo 50.
    const internalPoId = await createFixturePurchaseOrder(admin, organization.id, anyMember.user_id, skuKey, {
      status: "ordered",
      transitAccountingSource: "internal",
      quantityOrdered: 30,
    });
    purchaseOrderIds.push(internalPoId);

    const { data: afterInternal, error: afterInternalError } = await admin.rpc(
      "get_purchase_planning_signal_for_sku",
      { target_organization_id: organization.id, target_source_sku_key: skuKey },
    );
    assert.equal(afterInternalError, null);
    assert.equal(afterInternal.upsellerPurchaseInTransit, 20);
    assert.equal(afterInternal.internalPurchaseInTransit, 30);
    assert.equal(afterInternal.effectivePurchaseInTransit, 50);

    await cleanupPurchaseOrders(admin, [internalPoId]);
    purchaseOrderIds.length = 0;

    // Cenário 2 — upseller_confirmed: UpSeller 20 + interno 30, mas
    // confirmado => efetivo continua 20 (não soma de novo).
    const confirmedPoId = await createFixturePurchaseOrder(admin, organization.id, anyMember.user_id, skuKey, {
      status: "ordered",
      transitAccountingSource: "upseller_confirmed",
      quantityOrdered: 30,
    });
    purchaseOrderIds.push(confirmedPoId);

    const { data: afterConfirmed, error: afterConfirmedError } = await admin.rpc(
      "get_purchase_planning_signal_for_sku",
      { target_organization_id: organization.id, target_source_sku_key: skuKey },
    );
    assert.equal(afterConfirmedError, null);
    assert.equal(afterConfirmed.upsellerPurchaseInTransit, 20);
    assert.equal(afterConfirmed.internalPurchaseInTransit, 0);
    assert.equal(afterConfirmed.effectivePurchaseInTransit, 20);
  },
);

test(
  "cenários 3-7 — draft/approved não somam; ordered soma; parcial reduz; recebido zera",
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

    const { data: anyMember } = await admin
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", organization.id)
      .limit(1)
      .single();
    assert.ok(anyMember);

    const skuKey = `__FIXTURE_PLANNING_${randomUUID()}`.toUpperCase();
    const productId = await createFixtureProduct(admin, organization.id, skuKey);
    let currentPoId: string | null = null;

    t.after(async () => {
      if (currentPoId) await cleanupPurchaseOrders(admin, [currentPoId]);
      await admin.from("product_inventory_links").delete().eq("product_id", productId);
      await admin.from("products").delete().eq("id", productId);
      if (cachedImportBatchId) {
        await admin.from("upseller_import_batches").delete().eq("id", cachedImportBatchId);
        cachedImportBatchId = null;
      }
    });

    await linkProduct(admin, organization.id, productId, skuKey);

    const organizationId: string = organization.id;

    async function readSignal() {
      const { data, error } = await admin.rpc("get_purchase_planning_signal_for_sku", {
        target_organization_id: organizationId,
        target_source_sku_key: skuKey,
      });
      assert.equal(error, null);
      return data as { internalPurchaseInTransit: number; effectivePurchaseInTransit: number };
    }

    // Cenário 3 — draft: +0.
    currentPoId = await createFixturePurchaseOrder(admin, organization.id, anyMember.user_id, skuKey, {
      status: "draft",
      quantityOrdered: 30,
    });
    assert.equal((await readSignal()).internalPurchaseInTransit, 0);
    await cleanupPurchaseOrders(admin, [currentPoId]);
    currentPoId = null;

    // Cenário 4 — approved: +0.
    currentPoId = await createFixturePurchaseOrder(admin, organization.id, anyMember.user_id, skuKey, {
      status: "approved",
      quantityOrdered: 30,
    });
    assert.equal((await readSignal()).internalPurchaseInTransit, 0);
    await cleanupPurchaseOrders(admin, [currentPoId]);
    currentPoId = null;

    // Cenário 5 — ordered: +30 (tudo pendente).
    currentPoId = await createFixturePurchaseOrder(admin, organization.id, anyMember.user_id, skuKey, {
      status: "ordered",
      quantityOrdered: 30,
    });
    assert.equal((await readSignal()).internalPurchaseInTransit, 30);
    await cleanupPurchaseOrders(admin, [currentPoId]);
    currentPoId = null;

    // Cenário 6 — parcialmente recebido: ordered 30, recebido 10 => interno 20.
    currentPoId = await createFixturePurchaseOrder(admin, organization.id, anyMember.user_id, skuKey, {
      status: "partially_received",
      quantityOrdered: 30,
      receivedQuantity: 10,
    });
    assert.equal((await readSignal()).internalPurchaseInTransit, 20);
    await cleanupPurchaseOrders(admin, [currentPoId]);
    currentPoId = null;

    // Cenário 7 — recebido integralmente: +0.
    currentPoId = await createFixturePurchaseOrder(admin, organization.id, anyMember.user_id, skuKey, {
      status: "received",
      quantityOrdered: 30,
      receivedQuantity: 30,
    });
    assert.equal((await readSignal()).internalPurchaseInTransit, 0);
  },
);
