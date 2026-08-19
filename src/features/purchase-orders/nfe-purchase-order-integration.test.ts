import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { createClient } from "@supabase/supabase-js";

import {
  type AdminClient,
  addFixtureMember,
  borrowRealUserIds,
  createFixtureImportBatch,
  createFixtureOrganization,
  createFixtureProduct,
  createFixtureStockState,
  createFixtureSupplier,
  deleteFixtureOrganization,
  fixtureSkuKey,
  hex64,
  linkProduct,
} from "./test-fixtures";

/*
 * Integration test against production credentials, gated on
 * NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY. Exercises
 * apply_nfe_stock_receipt (M4's mechanical diff of the pre-existing
 * NF-e RPC) both WITHOUT a purchase order (regression check — must
 * behave exactly as before ETAPA 33) and WITH one (the new atomic
 * linking behavior). Everything lives inside one throwaway fixture
 * organization, deleted (cascading) in `after`.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
const hasCredentials = Boolean(supabaseUrl && supabaseSecretKey);

let admin: AdminClient;
let organizationId: string;
let actorUserId: string;

const WAREHOUSE_KEY = "FIXTURE-WH";
const WAREHOUSE_NAME = "Fixture WH";

before(async () => {
  if (!hasCredentials) return;
  admin = createClient(supabaseUrl as string, supabaseSecretKey as string, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  organizationId = await createFixtureOrganization(admin);
  const [userA] = await borrowRealUserIds(admin, 1);
  actorUserId = userA;
  await addFixtureMember(admin, organizationId, actorUserId, "admin");
});

after(async () => {
  if (!hasCredentials) return;
  await deleteFixtureOrganization(admin, organizationId);
});

function fixtureAccessKey() {
  return String(Math.floor(Math.random() * 1e13)).padStart(44, "0");
}

async function setUpSku(purchaseInTransit = 0) {
  const skuKey = fixtureSkuKey("NFE");
  const productId = await createFixtureProduct(admin, organizationId, skuKey);
  await linkProduct(admin, organizationId, productId, skuKey);
  const importBatchId = await createFixtureImportBatch(admin, organizationId);
  await createFixtureStockState(admin, organizationId, skuKey, importBatchId, {
    warehouseKey: WAREHOUSE_KEY,
    warehouseName: WAREHOUSE_NAME,
    purchaseInTransit,
  });
  return { skuKey, productId, importBatchId };
}

async function createOrderedPurchaseOrder(
  skuKey: string,
  quantityOrdered: number,
  { supplierDocument = null as string | null } = {},
) {
  const supplierId = await createFixtureSupplier(admin, organizationId, actorUserId, {
    document: supplierDocument,
  });
  const { data: created, error: createError } = await admin.rpc("create_blank_purchase_order", {
    target_organization_id: organizationId,
    actor_user_id: actorUserId,
  });
  assert.equal(createError, null, createError?.message);
  const purchaseOrderId = created.purchaseOrderId as string;

  const { error: draftError } = await admin.rpc("update_purchase_order_draft", {
    target_organization_id: organizationId,
    actor_user_id: actorUserId,
    target_purchase_order_id: purchaseOrderId,
    expected_version: 1,
    supplier_id: supplierId,
  });
  assert.equal(draftError, null, draftError?.message);

  const { data: itemResult, error: itemError } = await admin.rpc("upsert_purchase_order_item", {
    target_organization_id: organizationId,
    actor_user_id: actorUserId,
    target_purchase_order_id: purchaseOrderId,
    expected_version: 2,
    source_sku_key: skuKey,
    quantity_ordered: quantityOrdered,
    is_manual_add: true,
  });
  assert.equal(itemError, null, itemError?.message);
  const purchaseOrderItemId = itemResult.purchaseOrderItemId as string;

  const { error: approveError } = await admin.rpc("approve_purchase_order", {
    target_organization_id: organizationId,
    actor_user_id: actorUserId,
    target_purchase_order_id: purchaseOrderId,
    expected_version: 3,
  });
  assert.equal(approveError, null, approveError?.message);

  const { error: orderedError } = await admin.rpc("mark_purchase_order_ordered", {
    target_organization_id: organizationId,
    actor_user_id: actorUserId,
    target_purchase_order_id: purchaseOrderId,
    expected_version: 4,
    destination_warehouse_key: WAREHOUSE_KEY,
    destination_warehouse_name: WAREHOUSE_NAME,
  });
  assert.equal(orderedError, null, orderedError?.message);

  return { purchaseOrderId, purchaseOrderItemId, supplierId };
}

function receiptPayload(overrides: Record<string, unknown> = {}) {
  return {
    accessKey: fixtureAccessKey(),
    invoiceNumber: `FIXTURE-${randomUUID().slice(0, 8)}`,
    protocolStatus: "100 - Autorizado",
    warehouseKey: WAREHOUSE_KEY,
    warehouseName: WAREHOUSE_NAME,
    sourceSha256: hex64(),
    ...overrides,
  };
}

function itemPayload(overrides: Record<string, unknown>) {
  return {
    lineNumber: 1,
    unitValue: 10,
    totalValue: 10,
    ...overrides,
  };
}

async function applyReceipt(payload: Record<string, unknown>, items: Record<string, unknown>[]) {
  return admin.rpc("apply_nfe_stock_receipt", {
    target_organization_id: organizationId,
    target_received_by: actorUserId,
    receipt_payload: payload,
    items_payload: items,
  });
}

async function fetchPurchaseOrderStatus(purchaseOrderId: string) {
  const { data, error } = await admin
    .from("purchase_orders")
    .select("status")
    .eq("id", purchaseOrderId)
    .single();
  assert.equal(error, null, error?.message);
  return data.status as string;
}

test(
  "recebimento sem pedido de compra continua funcionando sem alterações",
  { skip: !hasCredentials },
  async () => {
    const { skuKey, productId, importBatchId } = await setUpSku();

    const { data: receiptId, error } = await applyReceipt(receiptPayload(), [
      itemPayload({ productId, skuKey, quantity: 4, baselineImportId: importBatchId }),
    ]);
    assert.equal(error, null, error?.message);

    const { data: receipt, error: receiptError } = await admin
      .from("stock_receipts")
      .select("purchase_order_id")
      .eq("id", receiptId)
      .single();
    assert.equal(receiptError, null, receiptError?.message);
    assert.equal(receipt.purchase_order_id, null);

    const { data: items, error: itemsError } = await admin
      .from("stock_receipt_items")
      .select("purchase_order_item_id")
      .eq("receipt_id", receiptId);
    assert.equal(itemsError, null, itemsError?.message);
    assert.equal(items[0].purchase_order_item_id, null);
  },
);

test(
  "recebimento vinculado ao pedido é atômico: estoque e pedido avançam juntos",
  { skip: !hasCredentials },
  async () => {
    const { skuKey, productId, importBatchId } = await setUpSku();
    const { purchaseOrderId, purchaseOrderItemId } = await createOrderedPurchaseOrder(skuKey, 30, {
      supplierDocument: "12345678000199",
    });

    const { data: receiptId, error } = await applyReceipt(
      receiptPayload({ purchaseOrderId, supplierDocument: "12345678000199" }),
      [itemPayload({ productId, skuKey, quantity: 10, baselineImportId: importBatchId, purchaseOrderItemId })],
    );
    assert.equal(error, null, error?.message);

    const { data: receipt, error: receiptError } = await admin
      .from("stock_receipts")
      .select("purchase_order_id")
      .eq("id", receiptId)
      .single();
    assert.equal(receiptError, null, receiptError?.message);
    assert.equal(receipt.purchase_order_id, purchaseOrderId);

    assert.equal(await fetchPurchaseOrderStatus(purchaseOrderId), "partially_received");

    const { data: events, error: eventsError } = await admin
      .from("purchase_order_events")
      .select("event_type")
      .eq("purchase_order_id", purchaseOrderId)
      .eq("event_type", "receipt_linked");
    assert.equal(eventsError, null, eventsError?.message);
    assert.equal(events.length, 1);
  },
);

test(
  "documento do fornecedor divergente bloqueia (comparação exata) e não persiste nada",
  { skip: !hasCredentials },
  async () => {
    const { skuKey, productId, importBatchId } = await setUpSku();
    const { purchaseOrderId, purchaseOrderItemId } = await createOrderedPurchaseOrder(skuKey, 10, {
      supplierDocument: "11111111000191",
    });

    const payload = receiptPayload({ purchaseOrderId, supplierDocument: "99999999000199" });
    const { error } = await applyReceipt(payload, [
      itemPayload({ productId, skuKey, quantity: 5, baselineImportId: importBatchId, purchaseOrderItemId }),
    ]);
    assert.equal(error?.message, "supplier_document_mismatch");

    const { data: leftoverReceipts, error: leftoverError } = await admin
      .from("stock_receipts")
      .select("id")
      .eq("access_key", payload.accessKey);
    assert.equal(leftoverError, null, leftoverError?.message);
    assert.equal(leftoverReceipts.length, 0, "a falha deve reverter a transação inteira, sem receipt órfão");

    assert.equal(await fetchPurchaseOrderStatus(purchaseOrderId), "ordered");
  },
);

test(
  "documento do fornecedor vazio no pedido nunca bloqueia",
  { skip: !hasCredentials },
  async () => {
    const { skuKey, productId, importBatchId } = await setUpSku();
    const { purchaseOrderId, purchaseOrderItemId } = await createOrderedPurchaseOrder(skuKey, 10, {
      supplierDocument: null,
    });

    const { error } = await applyReceipt(
      receiptPayload({ purchaseOrderId, supplierDocument: "qualquer coisa" }),
      [itemPayload({ productId, skuKey, quantity: 5, baselineImportId: importBatchId, purchaseOrderItemId })],
    );
    assert.equal(error, null, error?.message);
  },
);

test(
  "item extra da nota (sem vínculo ao pedido) aplica normalmente ao lado do item vinculado",
  { skip: !hasCredentials },
  async () => {
    const skuA = await setUpSku();
    const skuB = await setUpSku();
    const { purchaseOrderId, purchaseOrderItemId } = await createOrderedPurchaseOrder(skuA.skuKey, 10);

    const { data: receiptId, error } = await applyReceipt(receiptPayload({ purchaseOrderId }), [
      itemPayload({
        lineNumber: 1,
        productId: skuA.productId,
        skuKey: skuA.skuKey,
        quantity: 5,
        baselineImportId: skuA.importBatchId,
        purchaseOrderItemId,
      }),
      itemPayload({
        lineNumber: 2,
        productId: skuB.productId,
        skuKey: skuB.skuKey,
        quantity: 3,
        baselineImportId: skuB.importBatchId,
      }),
    ]);
    assert.equal(error, null, error?.message);

    const { data: items, error: itemsError } = await admin
      .from("stock_receipt_items")
      .select("line_number, purchase_order_item_id")
      .eq("receipt_id", receiptId)
      .order("line_number");
    assert.equal(itemsError, null, itemsError?.message);
    assert.equal(items[0].purchase_order_item_id, purchaseOrderItemId);
    assert.equal(items[1].purchase_order_item_id, null);
  },
);

test(
  "item da nota vinculado a um item de OUTRO pedido é bloqueado",
  { skip: !hasCredentials },
  async () => {
    const { skuKey, productId, importBatchId } = await setUpSku();
    const { purchaseOrderId } = await createOrderedPurchaseOrder(skuKey, 10);
    const otherSku = await setUpSku();
    const { purchaseOrderItemId: foreignItemId } = await createOrderedPurchaseOrder(otherSku.skuKey, 10);

    const { error } = await applyReceipt(receiptPayload({ purchaseOrderId }), [
      itemPayload({
        productId,
        skuKey,
        quantity: 5,
        baselineImportId: importBatchId,
        purchaseOrderItemId: foreignItemId,
      }),
    ]);
    assert.equal(error?.message, "purchase_order_item_mismatch");
  },
);

test(
  "pedido em rascunho/aprovado (não em trânsito) não pode receber",
  { skip: !hasCredentials },
  async () => {
    const { skuKey, productId, importBatchId } = await setUpSku();
    const supplierId = await createFixtureSupplier(admin, organizationId, actorUserId);
    const { data: created, error: createError } = await admin.rpc("create_blank_purchase_order", {
      target_organization_id: organizationId,
      actor_user_id: actorUserId,
    });
    assert.equal(createError, null, createError?.message);
    const purchaseOrderId = created.purchaseOrderId as string;
    const { error: draftError } = await admin.rpc("update_purchase_order_draft", {
      target_organization_id: organizationId,
      actor_user_id: actorUserId,
      target_purchase_order_id: purchaseOrderId,
      expected_version: 1,
      supplier_id: supplierId,
    });
    assert.equal(draftError, null, draftError?.message);

    const { error } = await applyReceipt(receiptPayload({ purchaseOrderId }), [
      itemPayload({ productId, skuKey, quantity: 5, baselineImportId: importBatchId }),
    ]);
    assert.equal(error?.message, "purchase_order_not_receivable");
  },
);

test("pedido de compra inexistente é rejeitado", { skip: !hasCredentials }, async () => {
  const { skuKey, productId, importBatchId } = await setUpSku();
  const { error } = await applyReceipt(receiptPayload({ purchaseOrderId: randomUUID() }), [
    itemPayload({ productId, skuKey, quantity: 5, baselineImportId: importBatchId }),
  ]);
  assert.equal(error?.message, "purchase_order_not_found");
});

test(
  "recebimento parcial move para partially_received; completar move para received",
  { skip: !hasCredentials },
  async () => {
    const { skuKey, productId, importBatchId } = await setUpSku();
    const { purchaseOrderId, purchaseOrderItemId } = await createOrderedPurchaseOrder(skuKey, 30);

    const { error: partialError } = await applyReceipt(receiptPayload({ purchaseOrderId }), [
      itemPayload({ productId, skuKey, quantity: 10, baselineImportId: importBatchId, purchaseOrderItemId }),
    ]);
    assert.equal(partialError, null, partialError?.message);
    assert.equal(await fetchPurchaseOrderStatus(purchaseOrderId), "partially_received");

    const { error: completeError } = await applyReceipt(receiptPayload({ purchaseOrderId }), [
      itemPayload({ productId, skuKey, quantity: 20, baselineImportId: importBatchId, purchaseOrderItemId }),
    ]);
    assert.equal(completeError, null, completeError?.message);
    assert.equal(await fetchPurchaseOrderStatus(purchaseOrderId), "received");
  },
);

test(
  "sobre-entrega é sempre permitida e nunca bloqueia",
  { skip: !hasCredentials },
  async () => {
    const { skuKey, productId, importBatchId } = await setUpSku();
    const { purchaseOrderId, purchaseOrderItemId } = await createOrderedPurchaseOrder(skuKey, 5);

    const { error } = await applyReceipt(receiptPayload({ purchaseOrderId }), [
      itemPayload({ productId, skuKey, quantity: 8, baselineImportId: importBatchId, purchaseOrderItemId }),
    ]);
    assert.equal(error, null, error?.message);

    const { data: progress, error: progressError } = await admin
      .from("purchase_order_item_progress")
      .select("received_quantity, over_received_quantity, outstanding_quantity")
      .eq("purchase_order_item_id", purchaseOrderItemId)
      .single();
    assert.equal(progressError, null, progressError?.message);
    assert.equal(progress.received_quantity, 8);
    assert.equal(progress.over_received_quantity, 3);
    assert.equal(progress.outstanding_quantity, 0);

    assert.equal(await fetchPurchaseOrderStatus(purchaseOrderId), "received");
  },
);

test(
  "duplicar a mesma nota fiscal continua bloqueado mesmo com pedido vinculado",
  { skip: !hasCredentials },
  async () => {
    const { skuKey, productId, importBatchId } = await setUpSku();
    const { purchaseOrderId, purchaseOrderItemId } = await createOrderedPurchaseOrder(skuKey, 30);

    const payload = receiptPayload({ purchaseOrderId });
    const { error: firstError } = await applyReceipt(payload, [
      itemPayload({ productId, skuKey, quantity: 5, baselineImportId: importBatchId, purchaseOrderItemId }),
    ]);
    assert.equal(firstError, null, firstError?.message);

    const { error: duplicateError } = await applyReceipt(payload, [
      itemPayload({ productId, skuKey, quantity: 5, baselineImportId: importBatchId, purchaseOrderItemId }),
    ]);
    assert.ok(duplicateError, "a segunda tentativa com a mesma access_key deve falhar");
    assert.equal(duplicateError.code, "23505");
  },
);

test(
  "estoque alterado desde o preview (baseline desatualizado) ainda bloqueia",
  { skip: !hasCredentials },
  async () => {
    const { skuKey, productId } = await setUpSku();
    const { purchaseOrderId, purchaseOrderItemId } = await createOrderedPurchaseOrder(skuKey, 10);
    const staleImportBatchId = await createFixtureImportBatch(admin, organizationId);

    const { error } = await applyReceipt(receiptPayload({ purchaseOrderId }), [
      itemPayload({
        productId,
        skuKey,
        quantity: 5,
        baselineImportId: staleImportBatchId,
        purchaseOrderItemId,
      }),
    ]);
    assert.equal(error?.message, "stock_changed_since_receipt_preview");
  },
);
