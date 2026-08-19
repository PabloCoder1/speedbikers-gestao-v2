import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createClient } from "@supabase/supabase-js";

import {
  type AdminClient,
  addFixtureMember,
  borrowRealUserIds,
  createFixtureOrganization,
  createFixtureProduct,
  deleteFixtureOrganization,
  fixtureSkuKey,
  linkProduct,
} from "./test-fixtures";

/*
 * Integration test against production credentials, gated on
 * NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY. Exercises
 * create_purchase_order_from_planning's duplicate-order guard: an
 * open PO (draft/approved/ordered/partially_received) already
 * covering a requested SKU blocks the WHOLE batch — all or nothing,
 * never a silent partial creation. Everything lives inside one
 * throwaway fixture organization, deleted (cascading) in `after`.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
const hasCredentials = Boolean(supabaseUrl && supabaseSecretKey);

let admin: AdminClient;
let organizationId: string;
let actorUserId: string;

before(async () => {
  if (!hasCredentials) return;
  admin = createClient(supabaseUrl as string, supabaseSecretKey as string, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  organizationId = await createFixtureOrganization(admin);
  const [userA] = await borrowRealUserIds(admin, 1);
  actorUserId = userA;
  await addFixtureMember(admin, organizationId, actorUserId, "operador");
});

after(async () => {
  if (!hasCredentials) return;
  await deleteFixtureOrganization(admin, organizationId);
});

async function setUpSku() {
  const skuKey = fixtureSkuKey("DUPGUARD");
  const productId = await createFixtureProduct(admin, organizationId, skuKey);
  await linkProduct(admin, organizationId, productId, skuKey);
  return skuKey;
}

async function seedExistingPurchaseOrder(skuKey: string, status: string) {
  const { data: po, error: poError } = await admin
    .from("purchase_orders")
    .insert({ organization_id: organizationId, status, created_by: actorUserId })
    .select("id, order_number")
    .single();
  assert.equal(poError, null, poError?.message);

  const { error: itemError } = await admin.from("purchase_order_items").insert({
    organization_id: organizationId,
    purchase_order_id: po.id,
    source_sku: skuKey,
    source_sku_key: skuKey,
    quantity_ordered: 1,
  });
  assert.equal(itemError, null, itemError?.message);

  return po as { id: string; order_number: number };
}

async function createFromPlanning(sourceSkuKeys: string[]) {
  return admin.rpc("create_purchase_order_from_planning", {
    target_organization_id: organizationId,
    actor_user_id: actorUserId,
    source_sku_keys: sourceSkuKeys,
  });
}

test(
  "cria pedido normalmente quando o SKU não está em nenhum pedido aberto",
  { skip: !hasCredentials },
  async () => {
    const skuKey = await setUpSku();
    const { data, error } = await createFromPlanning([skuKey]);
    assert.equal(error, null, error?.message);
    assert.equal(data.created, true);
    assert.ok(data.purchaseOrderId);

    const { data: items } = await admin
      .from("purchase_order_items")
      .select("source_sku_key, quantity_ordered")
      .eq("purchase_order_id", data.purchaseOrderId);
    assert.equal(items.length, 1);
    assert.equal(items[0].source_sku_key, skuKey);
    // Re-derived server-side (no client-trusted quantity was sent) —
    // at minimum 1 even with no real planning signal for a bare fixture SKU.
    assert.ok(items[0].quantity_ordered >= 1);
  },
);

for (const openStatus of ["draft", "approved", "ordered", "partially_received"]) {
  test(
    `bloqueia com pedido existente aberto (status=${openStatus}) e retorna existingOpenOrders`,
    { skip: !hasCredentials },
    async () => {
      const skuKey = await setUpSku();
      const existing = await seedExistingPurchaseOrder(skuKey, openStatus);

      const { data, error } = await createFromPlanning([skuKey]);
      assert.equal(error, null, error?.message);
      assert.equal(data.created, false);
      assert.equal(data.existingOpenOrders.length, 1);
      assert.equal(data.existingOpenOrders[0].purchaseOrderId, existing.id);
      assert.equal(data.existingOpenOrders[0].status, openStatus);
      assert.equal(data.existingOpenOrders[0].sourceSkuKey, skuKey);
    },
  );
}

for (const closedStatus of ["received", "cancelled"]) {
  test(
    `NÃO bloqueia quando o pedido existente já está fechado (status=${closedStatus})`,
    { skip: !hasCredentials },
    async () => {
      const skuKey = await setUpSku();
      await seedExistingPurchaseOrder(skuKey, closedStatus);

      const { data, error } = await createFromPlanning([skuKey]);
      assert.equal(error, null, error?.message);
      assert.equal(data.created, true);
    },
  );
}

test(
  "tudo ou nada: um SKU já aberto no lote bloqueia o lote inteiro, sem criação parcial",
  { skip: !hasCredentials },
  async () => {
    const freeSkuKey = await setUpSku();
    const openSkuKey = await setUpSku();
    await seedExistingPurchaseOrder(openSkuKey, "approved");

    const { count: beforeCount } = await admin
      .from("purchase_orders")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId);

    const { data, error } = await createFromPlanning([freeSkuKey, openSkuKey]);
    assert.equal(error, null, error?.message);
    assert.equal(data.created, false);
    assert.equal(data.existingOpenOrders.length, 1);
    assert.equal(data.existingOpenOrders[0].sourceSkuKey, openSkuKey);

    const { count: afterCount } = await admin
      .from("purchase_orders")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId);
    assert.equal(afterCount, beforeCount, "nenhum novo pedido deve ter sido criado quando o lote é bloqueado");

    const { data: freeSkuOrders } = await admin
      .from("purchase_order_items")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("source_sku_key", freeSkuKey);
    assert.equal(freeSkuOrders.length, 0, "o SKU livre não deve ter sido inserido em nenhum pedido");
  },
);
