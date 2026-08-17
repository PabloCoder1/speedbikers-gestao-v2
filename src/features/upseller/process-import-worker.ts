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
const CHUNK_SIZE = 1500;
const MAX_STAGING_CHUNKS_PER_CLAIM = 8;
const DEFAULT_BURST_RUNTIME_MS = 40_000;
const DEFAULT_BURST_CHUNKS = 96;

type StagingPhase = "stock" | "products" | "relationships" | "kits";
type PromotionPhase =
  | "promote"
  | "promote_catalog"
  | "promote_stock"
  | "promote_relationships"
  | "promote_kits"
  | "derive_kits"
  | "build_links_exact"
  | "build_links_item"
  | "build_links_variation"
  | "build_links_user_product"
  | "promote_links"
  | "finalize";
type ImportPhase = StagingPhase | PromotionPhase;

type ImportBatch = {
  id: string;
  organization_id: string;
  phase: ImportPhase | null;
  cursor_row: number;
  stock_storage_path: string | null;
  relationship_storage_path: string | null;
  product_storage_path: string | null;
  kit_storage_path: string | null;
  warehouse_zip_storage_path: string | null;
  attempt_count: number;
  max_attempts: number;
};

function nextStagingPhase(phase: StagingPhase): ImportPhase {
  if (phase === "stock") return "products";
  if (phase === "products") return "relationships";
  if (phase === "relationships") return "kits";
  return "promote_catalog";
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

function isStagingPhase(phase: ImportPhase): phase is StagingPhase {
  return phase === "stock" || phase === "products" || phase === "relationships" || phase === "kits";
}

function promotionErrorCode(phase: ImportPhase) {
  if (phase === "promote_stock") return "UPS_IMPORT_PROMOTE_STOCK_FAILED";
  if (phase === "promote_relationships") return "UPS_IMPORT_PROMOTE_RELATIONSHIPS_FAILED";
  if (phase.startsWith("build_links") || phase === "promote_links") return "UPS_IMPORT_LINK_BUILD_FAILED";
  if (phase === "promote_kits" || phase === "derive_kits") return "UPS_IMPORT_PROMOTE_KITS_FAILED";
  if (phase === "promote_catalog" || phase === "promote") return "UPS_IMPORT_PROMOTE_CATALOG_FAILED";
  return "UPS_IMPORT_FINALIZE_FAILED";
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
    .select("id,organization_id,phase,cursor_row,stock_storage_path,relationship_storage_path,product_storage_path,kit_storage_path,warehouse_zip_storage_path,attempt_count,max_attempts")
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

  const phase = batch.phase ?? "stock";
  try {
    if (!isStagingPhase(phase)) {
      const { data, error } = await admin.rpc("promote_upseller_import_chunk", {
        target_import_id: batch.id,
        requested_lease_id: leaseId,
        chunk_size: CHUNK_SIZE,
      });
      if (error || !data) {
        throw new Error(`${promotionErrorCode(phase)}:${error?.message ?? "empty_result"}`);
      }
      const result = data as { completed?: boolean; phase?: string; cursorRow?: number };
      return {
        processed: true,
        completed: result.completed === true,
        importId: batch.id,
        phase: result.phase ?? phase,
        cursorRow: result.cursorRow ?? 0,
      } as const;
    }

    const directStoragePath = phase === "stock"
      ? batch.stock_storage_path
      : phase === "relationships"
        ? batch.relationship_storage_path
        : phase === "products"
          ? batch.product_storage_path
          : batch.kit_storage_path;
    const legacyWarehouseFallback = (phase === "products" || phase === "kits") && !directStoragePath;
    const storagePath = directStoragePath ?? (legacyWarehouseFallback ? batch.warehouse_zip_storage_path : null);
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
      const parsed = legacyWarehouseFallback
        ? (phase === "products" ? (await parseWarehouseZip(buffer)).products : (await parseWarehouseZip(buffer)).kits)
        : phase === "products"
          ? await parseProductWorkbook(buffer)
          : await parseKitWorkbook(buffer);
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
          definition_source: row.definitionSource, row_hash: row.rowHash, raw_payload: row.rawPayload,
        }));
      }
    }

    let newCursor = batch.cursor_row;
    let stagedRows = 0;
    for (let chunkIndex = 0; chunkIndex < MAX_STAGING_CHUNKS_PER_CLAIM; chunkIndex += 1) {
      const chunk = rows.slice(newCursor, newCursor + CHUNK_SIZE);
      if (chunk.length === 0) break;
      const { error: stageError } = await admin.from(table).upsert(chunk, { onConflict: "import_id,row_number" });
      if (stageError) throw new Error(`UPS_IMPORT_STAGE_FAILED:${stageError.message}`);
      newCursor += chunk.length;
      stagedRows += chunk.length;
      if (chunk.length < CHUNK_SIZE) break;
    }
    if (newCursor >= rows.length) {
      await release({
        status: "queued", phase: nextStagingPhase(phase), cursor_row: 0,
        attempt_count: 0, next_attempt_at: new Date().toISOString(), error_code: null, error_message: null,
      });
      return { processed: true, completed: false, importId: batch.id, phase, staged: stagedRows, phaseComplete: true } as const;
    }
    await release({
      status: "queued", cursor_row: newCursor, attempt_count: 0,
      next_attempt_at: new Date().toISOString(), error_code: null, error_message: null,
    });
    return { processed: true, completed: false, importId: batch.id, phase, staged: stagedRows, cursorRow: newCursor } as const;
  } catch (error) {
    const attempt = batch.attempt_count + 1;
    const failed = attempt >= batch.max_attempts;
    const phaseCode = isStagingPhase(phase) ? "UPS_IMPORT_STAGE_FAILED" : promotionErrorCode(phase);
    const { error: retryCheckpointError } = await admin.from("upseller_import_batches").update({
      status: failed ? "failed" : "queued",
      attempt_count: attempt,
      next_attempt_at: new Date(Date.now() + retrySeconds(attempt) * 1000).toISOString(),
      lease_id: null,
      lease_expires_at: null,
      error_code: phaseCode,
      error_message: `${phaseCode}:${compactError(error)}`.slice(0, 500),
    }).eq("id", batch.id).eq("lease_id", leaseId);
    if (retryCheckpointError) {
      throw new Error(`UPS_IMPORT_RETRY_CHECKPOINT_FAILED:${retryCheckpointError.message}`);
    }
    throw error;
  }
}

export async function processUpsellerImportBurst({
  maxRuntimeMs = DEFAULT_BURST_RUNTIME_MS,
  maxChunks = DEFAULT_BURST_CHUNKS,
}: {
  maxRuntimeMs?: number;
  maxChunks?: number;
} = {}) {
  const startedAt = Date.now();
  let iterations = 0;
  let completedImports = 0;
  let lastResult: Awaited<ReturnType<typeof processNextUpsellerImportChunk>> | null = null;

  while (iterations < maxChunks && Date.now() - startedAt < maxRuntimeMs) {
    const result = await processNextUpsellerImportChunk();
    lastResult = result;
    if (!result.processed) break;
    iterations += 1;
    if (result.completed) completedImports += 1;
  }

  return {
    processed: iterations > 0,
    iterations,
    completedImports,
    durationMs: Date.now() - startedAt,
    deadlineReached: Date.now() - startedAt >= maxRuntimeMs,
    lastResult,
  } as const;
}
