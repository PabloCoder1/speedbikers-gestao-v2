import { randomUUID } from "node:crypto";

/*
 * Shared fixture helpers for the ETAPA 33 credentialed integration
 * tests. Every mutating helper here operates inside a throwaway
 * fixture organization (created by createFixtureOrganization) — every
 * table touched by these tests (organizations, organization_members,
 * products, product_inventory_links, upseller_import_batches,
 * upseller_stock_states, upseller_kits, suppliers,
 * supplier_product_links, purchase_orders, purchase_order_items,
 * purchase_order_events, stock_receipts, stock_receipt_items) has its
 * organization_id foreign key declared ON DELETE CASCADE, so deleting
 * the fixture organization at the end of a test is sufficient to
 * remove every row created during that test — verified against the
 * migrations that define each table.
 *
 * organization_members.user_id has a hard FK to auth.users(id): we
 * never create or delete real auth users for these tests. Instead we
 * "borrow" existing real user ids (via borrowRealUserIds) purely to
 * satisfy that FK, and grant them fixture-scoped roles ONLY inside
 * the fixture organization — their membership/role in any real
 * organization is never read, written, or touched.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdminClient = any;

export function hex64() {
  return (randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 64);
}

export function fixtureSkuKey(tag: string) {
  return `__FIXTURE_${tag}_${randomUUID()}`.toUpperCase();
}

export async function createFixtureOrganization(admin: AdminClient) {
  const slug = `fixture-po-${randomUUID().slice(0, 8)}`;
  const { data, error } = await admin
    .from("organizations")
    .insert({ name: `Fixture PO ${slug}`, slug })
    .select("id")
    .single();
  if (error || !data) throw new Error(`failed to create fixture organization: ${error?.message}`);
  return data.id as string;
}

export async function deleteFixtureOrganization(admin: AdminClient, organizationId: string) {
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
    throw new Error(
      `failed to borrow ${count} real user id(s) to satisfy the organization_members.user_id FK: ${error?.message}`,
    );
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

export async function createFixtureProduct(admin: AdminClient, organizationId: string, skuKey: string) {
  const { data, error } = await admin
    .from("products")
    .insert({ organization_id: organizationId, sku: skuKey, sku_key: skuKey, name: "fixture product" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`failed to create fixture product: ${error?.message}`);
  return data.id as string;
}

export async function linkProduct(
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

export async function createFixtureImportBatch(admin: AdminClient, organizationId: string) {
  const { data, error } = await admin
    .from("upseller_import_batches")
    .insert({ organization_id: organizationId, status: "applied", import_fingerprint: hex64() })
    .select("id")
    .single();
  if (error || !data) throw new Error(`failed to create fixture import batch: ${error?.message}`);
  return data.id as string;
}

export async function createFixtureStockState(
  admin: AdminClient,
  organizationId: string,
  skuKey: string,
  importBatchId: string,
  {
    warehouseKey = "FIXTURE-WH",
    warehouseName = "Fixture WH",
    purchaseInTransit = 0,
  }: { warehouseKey?: string; warehouseName?: string; purchaseInTransit?: number } = {},
) {
  const { error } = await admin.from("upseller_stock_states").insert({
    organization_id: organizationId,
    source_sku: skuKey,
    sku_key: skuKey,
    warehouse_name: warehouseName,
    warehouse_key: warehouseKey,
    low_stock_threshold: 0,
    purchase_in_transit: purchaseInTransit,
    transfer_in_transit: 0,
    occupied_quantity: 0,
    available_quantity: 0,
    current_quantity: 0,
    state_hash: hex64(),
    source_import_id: importBatchId,
  });
  if (error) throw new Error(`failed to create fixture stock state: ${error.message}`);
}

export async function createFixtureKit(
  admin: AdminClient,
  organizationId: string,
  kitSkuKey: string,
  importBatchId: string,
) {
  const { error } = await admin.from("upseller_kits").insert({
    organization_id: organizationId,
    kit_sku: kitSkuKey,
    kit_sku_key: kitSkuKey,
    is_current: true,
    source_import_id: importBatchId,
  });
  if (error) throw new Error(`failed to create fixture kit: ${error.message}`);
}

export async function createFixtureSupplier(
  admin: AdminClient,
  organizationId: string,
  actorUserId: string,
  { document = null }: { document?: string | null } = {},
) {
  const { data, error } = await admin.rpc("create_supplier", {
    target_organization_id: organizationId,
    actor_user_id: actorUserId,
    name: `Fixture supplier ${randomUUID().slice(0, 8)}`,
    document,
  });
  if (error || !data) throw new Error(`failed to create fixture supplier: ${error?.message}`);
  return data as string;
}
