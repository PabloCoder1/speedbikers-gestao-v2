import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createClient } from "@supabase/supabase-js";

import {
  type AdminClient,
  addFixtureMember,
  borrowRealUserIds,
  createFixtureImportBatch,
  createFixtureKit,
  createFixtureOrganization,
  createFixtureSupplier,
  deleteFixtureOrganization,
  fixtureSkuKey,
  hex64,
} from "./test-fixtures";

/*
 * Integration test against production credentials, gated on
 * NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY (skips silently
 * without them). Exercises the purchase order status machine and its
 * mutation RPCs end to end. Every row lives inside one throwaway
 * fixture organization created in `before` and deleted (cascading)
 * in `after` — see test-fixtures.ts for why that fully cleans up.
 *
 * Role coverage borrows three real user ids and grants them
 * fixture-scoped roles (admin/gestor/operador) ONLY inside the
 * fixture organization — no real membership is ever read or changed.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
const hasCredentials = Boolean(supabaseUrl && supabaseSecretKey);

let admin: AdminClient;
let organizationId: string;
let adminUserId: string;
let managerUserId: string;
let operatorUserId: string;

before(async () => {
  if (!hasCredentials) return;
  admin = createClient(supabaseUrl as string, supabaseSecretKey as string, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  organizationId = await createFixtureOrganization(admin);
  const [userA, userB, userC] = await borrowRealUserIds(admin, 3);
  adminUserId = userA;
  managerUserId = userB;
  operatorUserId = userC;
  await addFixtureMember(admin, organizationId, adminUserId, "admin");
  await addFixtureMember(admin, organizationId, managerUserId, "gestor");
  await addFixtureMember(admin, organizationId, operatorUserId, "operador");
});

after(async () => {
  if (!hasCredentials) return;
  await deleteFixtureOrganization(admin, organizationId);
});

async function createBlankPO(actorUserId: string) {
  const { data, error } = await admin.rpc("create_blank_purchase_order", {
    target_organization_id: organizationId,
    actor_user_id: actorUserId,
  });
  assert.equal(error, null, error?.message);
  return data as { purchaseOrderId: string; orderNumber: number };
}

async function currentVersion(purchaseOrderId: string) {
  const { data, error } = await admin
    .from("purchase_orders")
    .select("version, status, supplier_id, expected_at, ordered_at, transit_accounting_source")
    .eq("id", purchaseOrderId)
    .single();
  assert.equal(error, null);
  return data as {
    version: number;
    status: string;
    supplier_id: string | null;
    expected_at: string | null;
    ordered_at: string | null;
    transit_accounting_source: string;
  };
}

async function addManualItem(
  purchaseOrderId: string,
  expectedVersion: number,
  actorUserId: string,
  skuKey: string,
  quantityOrdered: number,
) {
  return admin.rpc("upsert_purchase_order_item", {
    target_organization_id: organizationId,
    actor_user_id: actorUserId,
    target_purchase_order_id: purchaseOrderId,
    expected_version: expectedVersion,
    source_sku_key: skuKey,
    quantity_ordered: quantityOrdered,
    is_manual_add: true,
  });
}

test("cria rascunho e rascunho é editável (adicionar/editar item)", { skip: !hasCredentials }, async () => {
  const { purchaseOrderId } = await createBlankPO(operatorUserId);
  const afterCreate = await currentVersion(purchaseOrderId);
  assert.equal(afterCreate.status, "draft");
  assert.equal(afterCreate.supplier_id, null);
  assert.equal(afterCreate.version, 1);

  const skuKey = fixtureSkuKey("LIFECYCLE_EDIT");
  const { data: addResult, error: addError } = await addManualItem(
    purchaseOrderId,
    1,
    operatorUserId,
    skuKey,
    10,
  );
  assert.equal(addError, null, addError?.message);
  assert.equal(addResult.version, 2);

  const { data: item } = await admin
    .from("purchase_order_items")
    .select("id, quantity_ordered")
    .eq("id", addResult.purchaseOrderItemId)
    .single();
  assert.equal(item.quantity_ordered, 10);

  // Editing (same source_sku_key) updates the existing row instead of
  // inserting a duplicate.
  const { data: editResult, error: editError } = await addManualItem(
    purchaseOrderId,
    2,
    operatorUserId,
    skuKey,
    25,
  );
  assert.equal(editError, null, editError?.message);
  assert.equal(editResult.purchaseOrderItemId, addResult.purchaseOrderItemId);
  assert.equal(editResult.version, 3);

  const { data: editedItem } = await admin
    .from("purchase_order_items")
    .select("quantity_ordered")
    .eq("id", addResult.purchaseOrderItemId)
    .single();
  assert.equal(editedItem.quantity_ordered, 25);
});

test(
  "aprovar exige fornecedor e ao menos um item",
  { skip: !hasCredentials },
  async () => {
    const { purchaseOrderId } = await createBlankPO(operatorUserId);

    // No items, no supplier yet: item check fires (supplier is
    // checked first in the RPC body, so this call should surface the
    // supplier error first).
    const { error: noSupplierError } = await admin.rpc("approve_purchase_order", {
      target_organization_id: organizationId,
      actor_user_id: managerUserId,
      target_purchase_order_id: purchaseOrderId,
      expected_version: 1,
    });
    assert.equal(noSupplierError?.message, "purchase_order_supplier_required");

    const supplierId = await createFixtureSupplier(admin, organizationId, managerUserId);
    const { error: versionAfterSupplierError } = await admin.rpc("update_purchase_order_draft", {
      target_organization_id: organizationId,
      actor_user_id: managerUserId,
      target_purchase_order_id: purchaseOrderId,
      expected_version: 1,
      supplier_id: supplierId,
    });
    assert.equal(versionAfterSupplierError, null, versionAfterSupplierError?.message);

    // Supplier present but zero items.
    const { error: noItemsError } = await admin.rpc("approve_purchase_order", {
      target_organization_id: organizationId,
      actor_user_id: managerUserId,
      target_purchase_order_id: purchaseOrderId,
      expected_version: 2,
    });
    assert.equal(noItemsError?.message, "purchase_order_requires_items");

    await addManualItem(purchaseOrderId, 2, operatorUserId, fixtureSkuKey("LIFECYCLE_APPROVE"), 5);

    const { data: approveResult, error: approveError } = await admin.rpc("approve_purchase_order", {
      target_organization_id: organizationId,
      actor_user_id: managerUserId,
      target_purchase_order_id: purchaseOrderId,
      expected_version: 3,
    });
    assert.equal(approveError, null, approveError?.message);
    assert.equal(approveResult, 4);

    const state = await currentVersion(purchaseOrderId);
    assert.equal(state.status, "approved");
  },
);

test(
  "operador não pode aprovar; gestor e admin podem",
  { skip: !hasCredentials },
  async () => {
    const supplierId = await createFixtureSupplier(admin, organizationId, adminUserId);

    async function draftReadyForApproval() {
      const { purchaseOrderId } = await createBlankPO(operatorUserId);
      await admin.rpc("update_purchase_order_draft", {
        target_organization_id: organizationId,
        actor_user_id: operatorUserId,
        target_purchase_order_id: purchaseOrderId,
        expected_version: 1,
        supplier_id: supplierId,
      });
      await addManualItem(purchaseOrderId, 2, operatorUserId, fixtureSkuKey("LIFECYCLE_ROLE"), 3);
      return purchaseOrderId;
    }

    const poForOperator = await draftReadyForApproval();
    const { error: operatorError } = await admin.rpc("approve_purchase_order", {
      target_organization_id: organizationId,
      actor_user_id: operatorUserId,
      target_purchase_order_id: poForOperator,
      expected_version: 3,
    });
    assert.equal(operatorError?.message, "purchase_order_not_authorized");

    const poForManager = await draftReadyForApproval();
    const { error: managerError } = await admin.rpc("approve_purchase_order", {
      target_organization_id: organizationId,
      actor_user_id: managerUserId,
      target_purchase_order_id: poForManager,
      expected_version: 3,
    });
    assert.equal(managerError, null, managerError?.message);

    const poForAdmin = await draftReadyForApproval();
    const { error: adminError } = await admin.rpc("approve_purchase_order", {
      target_organization_id: organizationId,
      actor_user_id: adminUserId,
      target_purchase_order_id: poForAdmin,
      expected_version: 3,
    });
    assert.equal(adminError, null, adminError?.message);
  },
);

test("pedido aprovado pode ser reaberto para rascunho", { skip: !hasCredentials }, async () => {
  const supplierId = await createFixtureSupplier(admin, organizationId, adminUserId);
  const { purchaseOrderId } = await createBlankPO(operatorUserId);
  await admin.rpc("update_purchase_order_draft", {
    target_organization_id: organizationId,
    actor_user_id: operatorUserId,
    target_purchase_order_id: purchaseOrderId,
    expected_version: 1,
    supplier_id: supplierId,
  });
  await addManualItem(purchaseOrderId, 2, operatorUserId, fixtureSkuKey("LIFECYCLE_REOPEN"), 4);
  await admin.rpc("approve_purchase_order", {
    target_organization_id: organizationId,
    actor_user_id: managerUserId,
    target_purchase_order_id: purchaseOrderId,
    expected_version: 3,
  });
  assert.equal((await currentVersion(purchaseOrderId)).status, "approved");

  const { error: operatorReopenError } = await admin.rpc("reopen_purchase_order", {
    target_organization_id: organizationId,
    actor_user_id: operatorUserId,
    target_purchase_order_id: purchaseOrderId,
    expected_version: 4,
  });
  assert.equal(operatorReopenError?.message, "purchase_order_not_authorized");

  const { error: reopenError } = await admin.rpc("reopen_purchase_order", {
    target_organization_id: organizationId,
    actor_user_id: managerUserId,
    target_purchase_order_id: purchaseOrderId,
    expected_version: 4,
  });
  assert.equal(reopenError, null, reopenError?.message);

  const state = await currentVersion(purchaseOrderId);
  assert.equal(state.status, "draft");
});

test(
  "marcar como pedido exige depósito e assume trânsito interno por padrão",
  { skip: !hasCredentials },
  async () => {
    const supplierId = await createFixtureSupplier(admin, organizationId, adminUserId);
    const { purchaseOrderId } = await createBlankPO(operatorUserId);
    await admin.rpc("update_purchase_order_draft", {
      target_organization_id: organizationId,
      actor_user_id: operatorUserId,
      target_purchase_order_id: purchaseOrderId,
      expected_version: 1,
      supplier_id: supplierId,
    });
    await addManualItem(purchaseOrderId, 2, operatorUserId, fixtureSkuKey("LIFECYCLE_ORDERED"), 6);
    await admin.rpc("approve_purchase_order", {
      target_organization_id: organizationId,
      actor_user_id: managerUserId,
      target_purchase_order_id: purchaseOrderId,
      expected_version: 3,
    });

    const { error: missingWarehouseError } = await admin.rpc("mark_purchase_order_ordered", {
      target_organization_id: organizationId,
      actor_user_id: managerUserId,
      target_purchase_order_id: purchaseOrderId,
      expected_version: 4,
      destination_warehouse_key: "",
      destination_warehouse_name: "",
    });
    assert.equal(missingWarehouseError?.message, "purchase_order_destination_required");

    const beforeOrdered = new Date();
    const { data: orderedResult, error: orderedError } = await admin.rpc("mark_purchase_order_ordered", {
      target_organization_id: organizationId,
      actor_user_id: managerUserId,
      target_purchase_order_id: purchaseOrderId,
      expected_version: 4,
      destination_warehouse_key: "FIXTURE-WH",
      destination_warehouse_name: "Fixture WH",
    });
    assert.equal(orderedError, null, orderedError?.message);

    const state = await currentVersion(purchaseOrderId);
    assert.equal(state.status, "ordered");
    assert.equal(state.transit_accounting_source, "internal");
    assert.ok(state.ordered_at);
    assert.ok(orderedResult.expectedAt);

    // No lead_time_days_snapshot on the manually-added item (no
    // planning signal was found for the fixture SKU), so the RPC
    // falls back to its documented 15-day default.
    const expectedAt = new Date(orderedResult.expectedAt);
    const deltaDays = (expectedAt.getTime() - beforeOrdered.getTime()) / (1000 * 60 * 60 * 24);
    assert.ok(deltaDays > 14.9 && deltaDays < 15.1, `expected ~15 days, got ${deltaDays}`);
  },
);

test(
  "conflito de concorrência otimista: versão desatualizada é rejeitada",
  { skip: !hasCredentials },
  async () => {
    const { purchaseOrderId } = await createBlankPO(operatorUserId);
    await addManualItem(purchaseOrderId, 1, operatorUserId, fixtureSkuKey("LIFECYCLE_STALE"), 2);
    // Real current version is now 2 — call with the stale value 1.
    const { error: staleError } = await admin.rpc("update_purchase_order_draft", {
      target_organization_id: organizationId,
      actor_user_id: operatorUserId,
      target_purchase_order_id: purchaseOrderId,
      expected_version: 1,
      notes: "should never be applied",
    });
    assert.equal(staleError?.message, "stale_purchase_order");

    const state = await currentVersion(purchaseOrderId);
    assert.notEqual(state.status, undefined);
    const { data: unchanged } = await admin
      .from("purchase_orders")
      .select("notes")
      .eq("id", purchaseOrderId)
      .single();
    assert.notEqual(unchanged.notes, "should never be applied");
  },
);

test("cancelar sem recebimento funciona; cancelar após recebimento é bloqueado", { skip: !hasCredentials }, async () => {
  const { purchaseOrderId: cleanPoId } = await createBlankPO(operatorUserId);
  await addManualItem(cleanPoId, 1, operatorUserId, fixtureSkuKey("LIFECYCLE_CANCEL_CLEAN"), 3);
  const { error: cancelCleanError } = await admin.rpc("cancel_purchase_order", {
    target_organization_id: organizationId,
    actor_user_id: managerUserId,
    target_purchase_order_id: cleanPoId,
    expected_version: 2,
  });
  assert.equal(cancelCleanError, null, cancelCleanError?.message);
  assert.equal((await currentVersion(cleanPoId)).status, "cancelled");

  // A PO with any received quantity (via a receipt row, independent
  // of how it was received) can never be cancelled.
  const { purchaseOrderId: receivedPoId } = await createBlankPO(operatorUserId);
  const receivedSkuKey = fixtureSkuKey("LIFECYCLE_CANCEL_BLOCKED");
  const { data: itemResult } = await addManualItem(receivedPoId, 1, operatorUserId, receivedSkuKey, 8);
  await seedFixtureReceipt(receivedPoId, itemResult.purchaseOrderItemId, receivedSkuKey, 3);

  const { error: blockedCancelError } = await admin.rpc("cancel_purchase_order", {
    target_organization_id: organizationId,
    actor_user_id: managerUserId,
    target_purchase_order_id: receivedPoId,
    expected_version: 2,
  });
  assert.equal(blockedCancelError?.message, "purchase_order_has_receipts");
});

test(
  "cancelar saldo restante após recebimento parcial fecha o pedido (com hasCancelledUnits)",
  { skip: !hasCredentials },
  async () => {
    const { purchaseOrderId } = await createBlankPO(operatorUserId);
    const skuA = fixtureSkuKey("LIFECYCLE_REMAINING_A");
    const skuB = fixtureSkuKey("LIFECYCLE_REMAINING_B");
    const { data: itemA } = await addManualItem(purchaseOrderId, 1, operatorUserId, skuA, 20);
    const { data: itemB } = await addManualItem(purchaseOrderId, 2, operatorUserId, skuB, 10);

    // Simulate a partial receipt on item A only (data shaping — the
    // receiving pipeline itself is exercised end to end in
    // nfe-purchase-order-integration.test.ts). Move the PO into
    // 'partially_received' directly since we are testing
    // cancel_purchase_order_item_remaining in isolation, not the
    // transition into that state.
    await seedFixtureReceipt(purchaseOrderId, itemA.purchaseOrderItemId, skuA, 12);
    const { error: setStatusError } = await admin
      .from("purchase_orders")
      .update({ status: "partially_received" })
      .eq("id", purchaseOrderId);
    assert.equal(setStatusError, null);

    const { data: cancelA, error: cancelAError } = await admin.rpc("cancel_purchase_order_item_remaining", {
      target_organization_id: organizationId,
      actor_user_id: managerUserId,
      target_purchase_order_id: purchaseOrderId,
      expected_version: 3,
      target_purchase_order_item_id: itemA.purchaseOrderItemId,
    });
    assert.equal(cancelAError, null, cancelAError?.message);
    assert.equal(cancelA.status, "partially_received");

    const { data: itemARow } = await admin
      .from("purchase_order_items")
      .select("cancelled_quantity")
      .eq("id", itemA.purchaseOrderItemId)
      .single();
    assert.equal(itemARow.cancelled_quantity, 8); // 20 ordered - 12 received

    const { data: cancelB, error: cancelBError } = await admin.rpc("cancel_purchase_order_item_remaining", {
      target_organization_id: organizationId,
      actor_user_id: managerUserId,
      target_purchase_order_id: purchaseOrderId,
      expected_version: 4,
      target_purchase_order_item_id: itemB.purchaseOrderItemId,
    });
    assert.equal(cancelBError, null, cancelBError?.message);
    // All items now have received + cancelled >= ordered -> auto 'received'.
    assert.equal(cancelB.status, "received");

    const finalState = await currentVersion(purchaseOrderId);
    assert.equal(finalState.status, "received");

    const { data: items } = await admin
      .from("purchase_order_item_progress")
      .select("purchase_order_item_id, received_quantity, cancelled_quantity, outstanding_quantity")
      .eq("purchase_order_id", purchaseOrderId);
    const hasCancelledUnits = items.some((row: { cancelled_quantity: number }) => row.cancelled_quantity > 0);
    assert.equal(hasCancelledUnits, true);
    for (const row of items as { outstanding_quantity: number }[]) {
      assert.equal(row.outstanding_quantity, 0);
    }
  },
);

test("adição manual rejeita SKU de kit", { skip: !hasCredentials }, async () => {
  const importBatchId = await createFixtureImportBatch(admin, organizationId);
  const kitSkuKey = fixtureSkuKey("LIFECYCLE_KIT");
  await createFixtureKit(admin, organizationId, kitSkuKey, importBatchId);

  const { purchaseOrderId } = await createBlankPO(operatorUserId);
  const { error } = await addManualItem(purchaseOrderId, 1, operatorUserId, kitSkuKey, 5);
  assert.equal(error?.message, "cannot_add_kit_sku");
});

test("remover item exige rascunho e bloqueia se já houver recebimento", { skip: !hasCredentials }, async () => {
  const { purchaseOrderId } = await createBlankPO(operatorUserId);
  const skuKey = fixtureSkuKey("LIFECYCLE_REMOVE");
  const { data: item } = await addManualItem(purchaseOrderId, 1, operatorUserId, skuKey, 5);

  const { data: removeResult, error: removeError } = await admin.rpc("remove_purchase_order_item", {
    target_organization_id: organizationId,
    actor_user_id: operatorUserId,
    target_purchase_order_id: purchaseOrderId,
    expected_version: 2,
    target_purchase_order_item_id: item.purchaseOrderItemId,
  });
  assert.equal(removeError, null, removeError?.message);
  assert.equal(removeResult, 3);

  const secondSkuKey = fixtureSkuKey("LIFECYCLE_REMOVE_BLOCKED");
  const { data: secondItem } = await addManualItem(purchaseOrderId, 3, operatorUserId, secondSkuKey, 5);
  await seedFixtureReceipt(purchaseOrderId, secondItem.purchaseOrderItemId, secondSkuKey, 1);

  const { error: blockedRemoveError } = await admin.rpc("remove_purchase_order_item", {
    target_organization_id: organizationId,
    actor_user_id: operatorUserId,
    target_purchase_order_id: purchaseOrderId,
    expected_version: 4,
    target_purchase_order_item_id: secondItem.purchaseOrderItemId,
  });
  assert.equal(blockedRemoveError?.message, "purchase_order_item_has_receipts");
});

// Inserts a stock_receipt + stock_receipt_item directly (bypassing
// apply_nfe_stock_receipt) purely as data shaping for tests that
// exercise a DIFFERENT RPC's read of purchase_order_item_progress.
// The receiving pipeline itself (and its own status-transition logic)
// is covered end to end in nfe-purchase-order-integration.test.ts.
async function seedFixtureReceipt(
  purchaseOrderId: string,
  purchaseOrderItemId: string,
  skuKey: string,
  quantity: number,
) {
  const importBatchId = await createFixtureImportBatch(admin, organizationId);
  const { data: receipt, error: receiptError } = await admin
    .from("stock_receipts")
    .insert({
      organization_id: organizationId,
      access_key: String(Math.floor(Math.random() * 1e13)).padStart(44, "0"),
      invoice_number: "FIXTURE",
      source_sha256: hex64(),
      destination_warehouse_name: "Fixture WH",
      destination_warehouse_key: "FIXTURE-WH",
      received_by: managerUserId,
      purchase_order_id: purchaseOrderId,
    })
    .select("id")
    .single();
  assert.equal(receiptError, null, receiptError?.message);

  const { error: itemError } = await admin.from("stock_receipt_items").insert({
    organization_id: organizationId,
    receipt_id: receipt.id,
    line_number: 1,
    source_sku: skuKey,
    sku_key: skuKey,
    quantity,
    baseline_import_id: importBatchId,
    purchase_order_item_id: purchaseOrderItemId,
  });
  assert.equal(itemError, null, itemError?.message);
}
