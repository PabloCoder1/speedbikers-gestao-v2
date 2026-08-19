import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createClient } from "@supabase/supabase-js";

import {
  type AdminClient,
  addFixtureMember,
  borrowRealUserIds,
  createFixtureMlAccount,
  createFixtureOrder,
  createFixtureOrderItem,
  createFixtureOrganization,
  createFixtureProduct,
  createFixtureSyncRun,
  deleteFixtureOrganization,
  fixtureExternalOrderId,
} from "./test-fixtures";

/*
 * Integration test against production credentials, gated on
 * NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY (skips silently
 * without them). Every row lives inside one throwaway fixture
 * organization created in `before` and deleted (cascading) in
 * `after`. RPCs are called with the service_role key, which the
 * migration explicitly allows to bypass the organization-membership
 * gate for testing (see sales-orders-security.test.ts for the
 * structural proof that RLS itself — the per-account permission
 * layer — is never bypassed for a real authenticated caller).
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
const hasCredentials = Boolean(supabaseUrl && supabaseSecretKey);

let admin: AdminClient;
let organizationId: string;
let mlAccountId: string;
let syncRunId: string;
let actorUserId: string;

before(async () => {
  if (!hasCredentials) return;
  admin = createClient(supabaseUrl as string, supabaseSecretKey as string, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  organizationId = await createFixtureOrganization(admin);
  const [userId] = await borrowRealUserIds(admin, 1);
  actorUserId = userId;
  await addFixtureMember(admin, organizationId, actorUserId, "admin");
  mlAccountId = await createFixtureMlAccount(admin, organizationId);
  syncRunId = await createFixtureSyncRun(admin, organizationId, mlAccountId);
});

after(async () => {
  if (!hasCredentials) return;
  await deleteFixtureOrganization(admin, organizationId);
});

const DAY_START_ISO = "2026-08-19T03:00:00.000Z"; // Sao Paulo midnight for 2026-08-19
const DAY_END_ISO = "2026-08-20T03:00:00.000Z";
const IN_RANGE_DATE = "2026-08-19T15:00:00.000Z";

async function callSummary(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin.rpc("get_sales_orders_summary", {
    target_organization_id: organizationId,
    date_from: DAY_START_ISO,
    date_to: DAY_END_ISO,
    target_ml_account_id: null,
    ...overrides,
  });
  assert.equal(error, null, error?.message);
  return data as Record<string, unknown>;
}

async function callPage(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin.rpc("get_sales_orders_page", {
    target_organization_id: organizationId,
    date_from: DAY_START_ISO,
    date_to: DAY_END_ISO,
    target_ml_account_id: null,
    status_filter: "all",
    search_query: "",
    cursor_date: null,
    cursor_id: null,
    page_size: 50,
    ...overrides,
  });
  assert.equal(error, null, error?.message);
  return data as { items: Record<string, unknown>[]; hasMore: boolean; nextCursor: Record<string, unknown> | null };
}

async function callDetail(orderId: string) {
  const { data, error } = await admin.rpc("get_sales_order_detail", {
    target_organization_id: organizationId,
    target_order_id: orderId,
  });
  assert.equal(error, null, error?.message);
  return data as Record<string, unknown> | null;
}

test("cenário 1 — pedido com 1 item aparece como uma linha com itemCount 1", { skip: !hasCredentials }, async () => {
  const orderId = await createFixtureOrder(admin, {
    organizationId,
    mlAccountId,
    syncRunId,
    dateCreated: IN_RANGE_DATE,
  });
  await createFixtureOrderItem(admin, { organizationId, mlAccountId, orderId, syncRunId, quantity: 3 });

  const page = await callPage();
  const row = page.items.find((item) => item.orderId === orderId);
  assert.ok(row, "fixture order not found in page");
  assert.equal(row!.itemCount, 1);
  assert.equal(row!.units, 3);
});

test("cenário 2 — pedido com múltiplos itens aparece uma única vez", { skip: !hasCredentials }, async () => {
  const orderId = await createFixtureOrder(admin, {
    organizationId,
    mlAccountId,
    syncRunId,
    dateCreated: IN_RANGE_DATE,
  });
  await createFixtureOrderItem(admin, { organizationId, mlAccountId, orderId, syncRunId, quantity: 1 });
  await createFixtureOrderItem(admin, { organizationId, mlAccountId, orderId, syncRunId, quantity: 2 });
  await createFixtureOrderItem(admin, { organizationId, mlAccountId, orderId, syncRunId, quantity: 4 });

  const page = await callPage();
  const rows = page.items.filter((item) => item.orderId === orderId);
  assert.equal(rows.length, 1, "the same order must not appear more than once");
  assert.equal(rows[0].itemCount, 3);
});

test("cenário 3 — unidades somam a quantidade dos itens current", { skip: !hasCredentials }, async () => {
  const orderId = await createFixtureOrder(admin, {
    organizationId,
    mlAccountId,
    syncRunId,
    dateCreated: IN_RANGE_DATE,
  });
  await createFixtureOrderItem(admin, { organizationId, mlAccountId, orderId, syncRunId, quantity: 5 });
  await createFixtureOrderItem(admin, { organizationId, mlAccountId, orderId, syncRunId, quantity: 7 });

  const page = await callPage();
  const row = page.items.find((item) => item.orderId === orderId);
  assert.equal(row!.units, 12);
});

test("cenário 4 — item com is_current=false não entra na soma de unidades", { skip: !hasCredentials }, async () => {
  const orderId = await createFixtureOrder(admin, {
    organizationId,
    mlAccountId,
    syncRunId,
    dateCreated: IN_RANGE_DATE,
  });
  await createFixtureOrderItem(admin, { organizationId, mlAccountId, orderId, syncRunId, quantity: 3, isCurrent: true });
  await createFixtureOrderItem(admin, {
    organizationId,
    mlAccountId,
    orderId,
    syncRunId,
    quantity: 999,
    isCurrent: false,
  });

  const page = await callPage();
  const row = page.items.find((item) => item.orderId === orderId);
  assert.equal(row!.units, 3, "the stale (is_current=false) line must never be counted");
  assert.equal(row!.itemCount, 1);
});

test("cenário 5 — taxas somam somente itens current", { skip: !hasCredentials }, async () => {
  const orderId = await createFixtureOrder(admin, {
    organizationId,
    mlAccountId,
    syncRunId,
    dateCreated: IN_RANGE_DATE,
  });
  await createFixtureOrderItem(admin, { organizationId, mlAccountId, orderId, syncRunId, saleFee: 10, isCurrent: true });
  await createFixtureOrderItem(admin, {
    organizationId,
    mlAccountId,
    orderId,
    syncRunId,
    saleFee: 5000,
    isCurrent: false,
  });

  const page = await callPage();
  const row = page.items.find((item) => item.orderId === orderId);
  assert.equal(row!.saleFees, 10);

  const summary = await callSummary();
  assert.ok((summary.saleFees as number) < 5000, "stale item fee must not leak into the summary total");
});

test("cenário 6 — item sem product_id gera 'com atenção'", { skip: !hasCredentials }, async () => {
  const orderId = await createFixtureOrder(admin, {
    organizationId,
    mlAccountId,
    syncRunId,
    dateCreated: IN_RANGE_DATE,
    status: "paid",
  });
  await createFixtureOrderItem(admin, { organizationId, mlAccountId, orderId, syncRunId, productId: null });

  const allPage = await callPage();
  const row = allPage.items.find((item) => item.orderId === orderId);
  assert.equal(row!.needsAttention, true);

  const attentionPage = await callPage({ status_filter: "attention" });
  assert.ok(attentionPage.items.some((item) => item.orderId === orderId));

  const paidPage = await callPage({ status_filter: "paid" });
  assert.ok(paidPage.items.some((item) => item.orderId === orderId), "paid filter is independent of attention");
});

test("cenário 8 — busca por external_order_id encontra o pedido", { skip: !hasCredentials }, async () => {
  const externalOrderId = fixtureExternalOrderId();
  const orderId = await createFixtureOrder(admin, {
    organizationId,
    mlAccountId,
    syncRunId,
    dateCreated: IN_RANGE_DATE,
    externalOrderId,
  });
  await createFixtureOrderItem(admin, { organizationId, mlAccountId, orderId, syncRunId });

  const page = await callPage({ search_query: externalOrderId });
  assert.ok(page.items.some((item) => item.orderId === orderId));
});

test("cenário 9 — busca por seller SKU encontra o pedido", { skip: !hasCredentials }, async () => {
  const sellerSku = `FIXTURE-SKU-${Date.now()}`;
  const orderId = await createFixtureOrder(admin, {
    organizationId,
    mlAccountId,
    syncRunId,
    dateCreated: IN_RANGE_DATE,
  });
  await createFixtureOrderItem(admin, { organizationId, mlAccountId, orderId, syncRunId, sellerSku });

  const page = await callPage({ search_query: sellerSku });
  assert.ok(page.items.some((item) => item.orderId === orderId));
});

test("cenário 10 — busca por SKU do produto (products.sku_key) encontra o pedido", { skip: !hasCredentials }, async () => {
  const skuKey = `__FIXTURE_SALES_${Date.now()}`;
  const productId = await createFixtureProduct(admin, organizationId, skuKey);
  const orderId = await createFixtureOrder(admin, {
    organizationId,
    mlAccountId,
    syncRunId,
    dateCreated: IN_RANGE_DATE,
  });
  await createFixtureOrderItem(admin, { organizationId, mlAccountId, orderId, syncRunId, productId });

  const page = await callPage({ search_query: skuKey });
  assert.ok(page.items.some((item) => item.orderId === orderId));
});

test("cenário 12 — paginação por cursor não duplica nem perde pedidos", { skip: !hasCredentials }, async () => {
  // Offset well clear of IN_RANGE_DATE (shared by every other scenario
  // in this file, in the same fixture org) so these 3 orders are
  // unambiguously the most recent in the scoped window — no timestamp
  // ties with unrelated fixtures that could push one out of a page.
  const baseTime = new Date(IN_RANGE_DATE).getTime() + 60 * 60_000;
  const orderIds: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const dateCreated = new Date(baseTime + i * 60_000).toISOString();
    const orderId = await createFixtureOrder(admin, { organizationId, mlAccountId, syncRunId, dateCreated });
    await createFixtureOrderItem(admin, { organizationId, mlAccountId, orderId, syncRunId });
    orderIds.push(orderId);
  }

  const firstPage = await callPage({ page_size: 2 });
  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);

  const secondPage = await callPage({
    page_size: 2,
    cursor_date: firstPage.nextCursor!.dateCreated,
    cursor_id: firstPage.nextCursor!.orderId,
  });

  const seenIds = [...firstPage.items, ...secondPage.items].map((item) => item.orderId);
  const seenFixtureIds = seenIds.filter((id) => orderIds.includes(id as string));
  assert.equal(new Set(seenFixtureIds).size, 3, "every fixture order must appear exactly once across both pages");
});

test("cenário 13 — detalhe de pedido de outra organização não vaza (retorna null)", { skip: !hasCredentials }, async () => {
  const otherOrganizationId = await createFixtureOrganization(admin);
  try {
    const otherAccountId = await createFixtureMlAccount(admin, otherOrganizationId);
    const otherSyncRunId = await createFixtureSyncRun(admin, otherOrganizationId, otherAccountId);
    const otherOrderId = await createFixtureOrder(admin, {
      organizationId: otherOrganizationId,
      mlAccountId: otherAccountId,
      syncRunId: otherSyncRunId,
    });

    const detail = await callDetail(otherOrderId);
    assert.equal(detail, null, "an order id from a different organization must never be returned");
  } finally {
    await deleteFixtureOrganization(admin, otherOrganizationId);
  }
});

test("cenário 14 — sales timeline lê de daily_product_metrics, não recalcula de orders", { skip: !hasCredentials }, async () => {
  const skuKey = `__FIXTURE_TIMELINE_${Date.now()}`;
  const productId = await createFixtureProduct(admin, organizationId, skuKey);

  const { error: metricError } = await admin.from("daily_product_metrics").insert({
    organization_id: organizationId,
    ml_account_id: mlAccountId,
    product_id: productId,
    metric_date: "2026-08-19",
    orders_count: 4,
    units_sold: 9,
    gross_revenue: 900,
    sale_fees: 45,
    net_after_sale_fee: 855,
    average_unit_price: 100,
  });
  assert.equal(metricError, null, metricError?.message);

  // Deliberately create a real order the same day with DIFFERENT
  // numbers — if the RPC were recomputing from orders instead of
  // reading daily_product_metrics, these fixture numbers would leak in.
  const orderId = await createFixtureOrder(admin, {
    organizationId,
    mlAccountId,
    syncRunId,
    dateCreated: IN_RANGE_DATE,
  });
  await createFixtureOrderItem(admin, {
    organizationId,
    mlAccountId,
    orderId,
    syncRunId,
    productId,
    quantity: 1234,
  });

  const { data, error } = await admin.rpc("get_product_sales_timeline_events", {
    target_organization_id: organizationId,
    target_product_id: productId,
    date_from: "2026-08-19",
    date_to: "2026-08-19",
    target_ml_account_id: null,
  });
  assert.equal(error, null, error?.message);

  const events = data as Record<string, unknown>[];
  assert.equal(events.length, 1);
  assert.equal(events[0].unitsSold, 9, "must reflect daily_product_metrics, not the 1234-unit fixture order item");
  assert.equal(events[0].ordersCount, 4);
  assert.equal(events[0].grossRevenue, 900);
});
