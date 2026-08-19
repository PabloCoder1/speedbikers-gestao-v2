import { randomUUID } from "node:crypto";

/*
 * Fixture helpers for the ETAPA 34 credentialed integration tests.
 * Same pattern as src/features/purchase-orders/test-fixtures.ts: every
 * table touched here (organizations, organization_members, ml_accounts,
 * sync_runs, products, orders, order_items) has its organization_id
 * foreign key declared ON DELETE CASCADE (verified against the live
 * schema), so deleting the fixture organization at the end of a test
 * is sufficient to remove every row created during that test.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdminClient = any;

export async function createFixtureOrganization(admin: AdminClient) {
  const slug = `fixture-sales-${randomUUID().slice(0, 8)}`;
  const { data, error } = await admin
    .from("organizations")
    .insert({ name: `Fixture Sales ${slug}`, slug })
    .select("id")
    .single();
  if (error || !data) throw new Error(`failed to create fixture organization: ${error?.message}`);
  return data.id as string;
}

export async function deleteFixtureOrganization(admin: AdminClient, organizationId: string) {
  // order_items_product_fk is a composite FK (organization_id, product_id)
  // -> products(organization_id, id) ON DELETE SET NULL. Postgres nulls
  // BOTH composite columns on that action, including organization_id,
  // which violates order_items' own NOT NULL constraint the moment a
  // referenced fixture product is cascade-deleted. Pre-existing schema
  // behavior (from 20260810164405), unrelated to ETAPA 34 — deleting
  // order_items explicitly first avoids ever triggering that path.
  const { error: orderItemsError } = await admin
    .from("order_items")
    .delete()
    .eq("organization_id", organizationId);
  if (orderItemsError) {
    throw new Error(`failed to delete fixture order_items before cascade: ${orderItemsError.message}`);
  }

  const { error } = await admin.from("organizations").delete().eq("id", organizationId);
  if (error) throw new Error(`failed to delete fixture organization (cascade): ${error.message}`);
}

export async function borrowRealUserIds(admin: AdminClient, count: number) {
  const { data, error } = await admin
    .from("organization_members")
    .select("user_id")
    .eq("is_active", true)
    .limit(count);
  if (error || !data || data.length < count) {
    throw new Error(`failed to borrow ${count} real user id(s): ${error?.message}`);
  }
  return data.map((row: { user_id: string }) => row.user_id as string);
}

export async function addFixtureMember(
  admin: AdminClient,
  organizationId: string,
  userId: string,
  role: string,
) {
  const { error } = await admin
    .from("organization_members")
    .insert({ organization_id: organizationId, user_id: userId, role, is_active: true });
  if (error) throw new Error(`failed to add fixture member: ${error.message}`);
}

// ml_accounts.code has a check constraint restricting it to the real
// account codes ('speedbikers'|'offracer'|'sb'|'gmr') — an arbitrary
// fixture string is rejected. Uniqueness is scoped per organization_id
// though, so reusing a real code inside a throwaway fixture org never
// collides with the real account of the same name.
export async function createFixtureMlAccount(
  admin: AdminClient,
  organizationId: string,
  code: "speedbikers" | "offracer" | "sb" | "gmr" = "speedbikers",
) {
  const { data, error } = await admin
    .from("ml_accounts")
    .insert({
      organization_id: organizationId,
      code,
      display_name: `Fixture ${code}`,
      oauth_app_code: code,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`failed to create fixture ml account: ${error?.message}`);
  return data.id as string;
}

export async function createFixtureSyncRun(
  admin: AdminClient,
  organizationId: string,
  mlAccountId: string,
) {
  const { data, error } = await admin
    .from("sync_runs")
    .insert({ organization_id: organizationId, ml_account_id: mlAccountId, sync_type: "order_refresh" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`failed to create fixture sync run: ${error?.message}`);
  return data.id as string;
}

export async function createFixtureProduct(admin: AdminClient, organizationId: string, skuKey: string) {
  const { data, error } = await admin
    .from("products")
    .insert({ organization_id: organizationId, sku: skuKey, sku_key: skuKey, name: "fixture product" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`failed to create fixture product: ${error?.message}`);
  return data.id as string;
}

let orderIdCounter = 0;
export function fixtureExternalOrderId() {
  orderIdCounter += 1;
  return `${Date.now()}${orderIdCounter}`.slice(0, 15);
}

export async function createFixtureOrder(
  admin: AdminClient,
  {
    organizationId,
    mlAccountId,
    syncRunId,
    externalOrderId = fixtureExternalOrderId(),
    status = "paid",
    totalAmount = 100,
    paidAmount = 100,
    dateCreated = new Date().toISOString(),
    mlLastUpdated = new Date().toISOString(),
    packId = null,
    shippingId = null,
  }: {
    organizationId: string;
    mlAccountId: string;
    syncRunId: string;
    externalOrderId?: string;
    status?: string;
    totalAmount?: number;
    paidAmount?: number;
    dateCreated?: string;
    mlLastUpdated?: string;
    packId?: string | null;
    shippingId?: string | null;
  },
) {
  const { data, error } = await admin
    .from("orders")
    .insert({
      organization_id: organizationId,
      ml_account_id: mlAccountId,
      external_order_id: externalOrderId,
      status,
      total_amount: totalAmount,
      paid_amount: paidAmount,
      date_created: dateCreated,
      ml_last_updated: mlLastUpdated,
      pack_id: packId,
      shipping_id: shippingId,
      last_seen_sync_run_id: syncRunId,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`failed to create fixture order: ${error?.message}`);
  return data.id as string;
}

export async function createFixtureOrderItem(
  admin: AdminClient,
  {
    organizationId,
    mlAccountId,
    orderId,
    syncRunId,
    productId = null,
    sellerSku = null,
    itemId = `MLB${Math.floor(Math.random() * 1_000_000_000)}`,
    variationId = null,
    title = "Fixture item",
    quantity = 1,
    unitPrice = 100,
    fullUnitPrice = null as number | null,
    saleFee = 5,
    isCurrent = true,
    lineKey,
  }: {
    organizationId: string;
    mlAccountId: string;
    orderId: string;
    syncRunId: string;
    productId?: string | null;
    sellerSku?: string | null;
    itemId?: string;
    variationId?: string | null;
    title?: string | null;
    quantity?: number;
    unitPrice?: number | null;
    fullUnitPrice?: number | null;
    saleFee?: number | null;
    isCurrent?: boolean;
    lineKey?: string;
  },
) {
  const resolvedLineKey = lineKey ?? `${itemId}:${variationId ?? "base"}`;
  const { data, error } = await admin
    .from("order_items")
    .insert({
      organization_id: organizationId,
      ml_account_id: mlAccountId,
      order_id: orderId,
      product_id: productId,
      line_key: resolvedLineKey,
      item_id: itemId,
      variation_id: variationId,
      seller_sku: sellerSku,
      title,
      quantity,
      unit_price: unitPrice,
      full_unit_price: fullUnitPrice,
      sale_fee: saleFee,
      is_current: isCurrent,
      last_seen_sync_run_id: syncRunId,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`failed to create fixture order item: ${error?.message}`);
  return data.id as string;
}
