import "server-only";

import { randomUUID } from "node:crypto";

import {
  parseKitWorkbook,
  parseProductWorkbook,
  parseRelationshipWorkbook,
  parseStockWorkbook,
  parseWarehouseZip,
  type ImportIssue,
} from "@/features/upseller/import-parser";
import { createAdminClient } from "@/lib/supabase/admin";

const LEASE_SECONDS = 120;
const CHUNK_SIZE = 2500;

type ImportPhase = "stock" | "products" | "relationships" | "kits" | "promote";
type ImportBatch = {
  id: string;
  organization_id: string;
  phase: ImportPhase | null;
  cursor_row: number;
  stock_storage_path: string;
  relationship_storage_path: string;
  warehouse_zip_storage_path: string;
  attempt_count: number;
  max_attempts: number;
};

function nextPhase(phase: ImportPhase): ImportPhase {
  if (phase === "stock") return "products";
  if (phase === "products") return "relationships";
  if (phase === "relationships") return "kits";
  return "promote";
}

function retrySeconds(attempt: number) {
  return Math.min(30 * 2 ** Math.max(0, attempt - 1) + Math.floor(Math.random() * 16), 15 * 60);
}

function compactError(error: unknown) {
  return (error instanceof Error ? error.message : "unknown_error").slice(0, 500);
}

function ensureValid(issues: ImportIssue[]) {
  if (issues.length > 0) throw new Error(`UPS_STAGING_VALIDATION_FAILED:${issues[0].code}`);
}

export async function processNextUpsellerImportChunk() {
  const admin = createAdminClient();
  const leaseId = randomUUID();
  const { data: importId, error: claimError } = await admin.rpc("claim_next_upseller_import", {
    requested_lease_id: leaseId,
    lease_duration_seconds: LEASE_SECONDS,
  });
  if (claimError) throw new Error(`UPS_IMPORT_CLAIM_FAILED:${claimError.message}`);
  if (!importId) return { processed: false, reason: "queue_empty" } as const;

  const { data: batch, error: batchError } = await admin
    .from("upseller_import_batches")
    .select("id,organization_id,phase,cursor_row,stock_storage_path,relationship_storage_path,warehouse_zip_storage_path,attempt_count,max_attempts")
    .eq("id", importId)
    .eq("lease_id", leaseId)
    .maybeSingle<ImportBatch>();
  if (batchError || !batch) throw new Error("UPS_IMPORT_LOAD_FAILED");

  const release = async (values: Record<string, unknown>) => {
    const { error } = await admin
      .from("upseller_import_batches")
      .update({ ...values, lease_id: null, lease_expires_at: null })
      .eq("id", batch.id)
      .eq("lease_id", leaseId);
    if (error) throw new Error(`UPS_IMPORT_CHECKPOINT_FAILED:${error.message}`);
  };

  try {
    const phase = batch.phase ?? "stock";
    if (phase === "promote") {
      const { data, error } = await admin.rpc("promote_upseller_import", { target_import_id: batch.id });
      if (error || !data) throw new Error(`UPS_IMPORT_PROMOTION_FAILED:${error?.message ?? "false"}`);
      return { processed: true, completed: true, importId: batch.id } as const;
    }

    const storagePath = phase === "stock"
      ? batch.stock_storage_path
      : phase === "relationships"
        ? batch.relationship_storage_path
        : batch.warehouse_zip_storage_path;
    if (!storagePath) throw new Error(`UPS_IMPORT_STORAGE_PATH_MISSING:${phase}`);
    const { data: file, error: downloadError } = await admin.storage.from("upseller-imports").download(storagePath);
    if (downloadError || !file) throw new Error(`UPS_IMPORT_DOWNLOAD_FAILED:${downloadError?.message ?? phase}`);
    const buffer = Buffer.from(await file.arrayBuffer());

    let rows: Record<string, unknown>[];
    let table: string;
    if (phase === "stock") {
      const parsed = await parseStockWorkbook(buffer);
      ensureValid(parsed.blockingIssues);
      table = "upseller_stock_import_rows";
      rows = parsed.rows.map((row) => ({
        import_id: batch.id, organization_id: batch.organization_id, row_number: row.rowNumber,
        source_sku: row.sourceSku, sku_key: row.skuKey, title: row.title,
        warehouse_name: row.warehouseName, warehouse_key: row.warehouseKey, shelf: row.shelf,
        low_stock_threshold: row.lowStockThreshold, purchase_in_transit: row.purchaseInTransit,
        transfer_in_transit: row.transferInTransit, occupied_quantity: row.occupiedQuantity,
        available_quantity: row.availableQuantity, current_quantity: row.currentQuantity,
        average_cost: row.averageCost, stock_value: row.stockValue,
        source_created_at_raw: row.sourceCreatedAtRaw, state_hash: row.stateHash,
        row_hash: row.rowHash, raw_payload: row.rawPayload,
      }));
    } else if (phase === "relationships") {
      const parsed = await parseRelationshipWorkbook(buffer);
      ensureValid(parsed.blockingIssues);
      table = "upseller_relationship_import_rows";
      rows = parsed.rows.map((row) => ({
        import_id: batch.id, organization_id: batch.organization_id, row_number: row.rowNumber,
        source_sku: row.sourceSku, source_sku_key: row.sourceSkuKey,
        mapped_listing_sku: row.mappedListingSku, mapped_listing_sku_key: row.mappedListingSkuKey,
        variant_label: row.variantLabel, listing_external_id: row.listingExternalId,
        variant_external_id: row.variantExternalId, store_name: row.storeName,
        store_name_key: row.storeNameKey, channel: row.channel,
        source_updated_at_raw: row.sourceUpdatedAtRaw, row_hash: row.rowHash, raw_payload: row.rawPayload,
      }));
    } else {
      const warehouse = await parseWarehouseZip(buffer);
      const parsed = phase === "products" ? warehouse.products : warehouse.kits;
      ensureValid(parsed.blockingIssues);
      if (phase === "products") {
        table = "upseller_product_import_rows";
        rows = (parsed as Awaited<ReturnType<typeof parseProductWorkbook>>).rows.map((row) => ({
          import_id: batch.id, organization_id: batch.organization_id, row_number: row.rowNumber,
          source_sku: row.sourceSku, sku_key: row.skuKey, spu: row.spu, product_code: row.productCode,
          title: row.title, product_alias: row.productAlias, invoice_alias_enabled: row.invoiceAliasEnabled,
          category: row.category, variant_dimensions: row.variantDimensions, launch_date_raw: row.launchDateRaw,
          is_active: row.isActive, seller: row.seller, retail_price: row.retailPrice,
          purchase_cost: row.purchaseCost, description: row.description, brand: row.brand,
          barcodes: row.barcodes, sku_alias: row.skuAlias, images: row.images, weight_g: row.weightG,
          length_cm: row.lengthCm, width_cm: row.widthCm, height_cm: row.heightCm, ncm: row.ncm,
          cest: row.cest, unit: row.unit, origin: row.origin, supplier_url: row.supplierUrl,
          row_hash: row.rowHash, raw_payload: row.rawPayload,
        }));
      } else {
        table = "upseller_kit_component_import_rows";
        rows = (parsed as Awaited<ReturnType<typeof parseKitWorkbook>>).rows.map((row) => ({
          import_id: batch.id, organization_id: batch.organization_id, row_number: row.rowNumber,
          kit_sku: row.kitSku, kit_sku_key: row.kitSkuKey, title: row.title, alias: row.alias,
          invoice_alias_enabled: row.invoiceAliasEnabled, category: row.category, is_active: row.isActive,
          image_url: row.imageUrl, component_sku: row.componentSku,
          component_sku_key: row.componentSkuKey, required_quantity: row.requiredQuantity,
          row_hash: row.rowHash, raw_payload: row.rawPayload,
        }));
      }
    }

    const chunk = rows.slice(batch.cursor_row, batch.cursor_row + CHUNK_SIZE);
    if (chunk.length > 0) {
      const { error: stageError } = await admin.from(table).upsert(chunk, { onConflict: "import_id,row_number" });
      if (stageError) throw new Error(`UPS_IMPORT_STAGE_FAILED:${stageError.message}`);
    }
    const newCursor = batch.cursor_row + chunk.length;
    if (newCursor >= rows.length) {
      await release({
        status: "queued", phase: nextPhase(phase), cursor_row: 0,
        attempt_count: 0, next_attempt_at: new Date().toISOString(), error_code: null, error_message: null,
      });
      return { processed: true, completed: false, importId: batch.id, phase, staged: chunk.length, phaseComplete: true } as const;
    }
    await release({
      status: "queued", cursor_row: newCursor, attempt_count: 0,
      next_attempt_at: new Date().toISOString(), error_code: null, error_message: null,
    });
    return { processed: true, completed: false, importId: batch.id, phase, staged: chunk.length, cursorRow: newCursor } as const;
  } catch (error) {
    const attempt = batch.attempt_count + 1;
    const failed = attempt >= batch.max_attempts;
    await admin.from("upseller_import_batches").update({
      status: failed ? "failed" : "queued",
      attempt_count: attempt,
      next_attempt_at: new Date(Date.now() + retrySeconds(attempt) * 1000).toISOString(),
      lease_id: null,
      lease_expires_at: null,
      error_code: "upseller_import_chunk_failed",
      error_message: compactError(error),
    }).eq("id", batch.id).eq("lease_id", leaseId);
    throw error;
  }
}
