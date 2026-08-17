import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { getAdminApiAccess } from "@/features/auth/get-admin-api-access";
import { parseUpsellerPackage } from "@/features/upseller/import-parser";
import { sha256 } from "@/features/stock/stock-domain";
import { createAdminClient } from "@/lib/supabase/admin";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isXlsxSignature(buffer: Buffer) {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2]);
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown_error";
  const known = message.startsWith("UPS_")
    ? message.split(":", 1)[0].toLowerCase()
    : "import_preview_failed";
  return NextResponse.json({ error: known }, { status: 400 });
}

export async function POST(request: Request) {
  const authorization = await getAdminApiAccess();
  if (!authorization.access) {
    return NextResponse.json({ error: authorization.status === 401 ? "not_authenticated" : "not_authorized" }, { status: authorization.status });
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_TOTAL_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: "upload_too_large" }, { status: 413 });
  }

  try {
    const form = await request.formData();
    const files = [form.get("stock"), form.get("relationships"), form.get("products"), form.get("kits")];
    if (!files.every((value): value is File => value instanceof File && value.size > 0)) {
      return NextResponse.json({ error: "required_files_missing" }, { status: 400 });
    }
    if (files.some((file) => file.size > MAX_FILE_BYTES) || files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) {
      return NextResponse.json({ error: "upload_too_large" }, { status: 413 });
    }
    const [stock, relationships, products, kits] = await Promise.all(
      files.map(async (file) => Buffer.from(await file.arrayBuffer())),
    );
    if (![stock, relationships, products, kits].every(isXlsxSignature)) {
      return NextResponse.json({ error: "invalid_office_or_zip_signature" }, { status: 400 });
    }

    const [stockHash, relationshipHash, productHash, kitHash] = [stock, relationships, products, kits].map(sha256);
    const importFingerprint = sha256([stockHash, relationshipHash, productHash, kitHash].join(":"));
    const admin = createAdminClient();
    const { data: duplicate, error: duplicateError } = await admin
      .from("upseller_import_batches")
      .select("id,status,preview_summary,validation_issues,created_at,applied_at")
      .eq("organization_id", authorization.access.organizationId)
      .eq("import_fingerprint", importFingerprint)
      .in("status", ["previewed", "queued", "running", "applied"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (duplicateError) throw new Error(`UPS_DUPLICATE_LOOKUP_FAILED:${duplicateError.message}`);
    if (duplicate) {
      return NextResponse.json({
        importId: duplicate.id,
        status: duplicate.status,
        ...(duplicate.preview_summary as Record<string, unknown>),
        duplicateImport: true,
      });
    }

    const parsed = await parseUpsellerPackage({ stock, relationships, products, kits });
    const importId = randomUUID();
    const basePath = `${authorization.access.organizationId}/${importId}`;
    const paths = {
      stock: `${basePath}/stock.xlsx`,
      relationships: `${basePath}/relationships.xlsx`,
      products: `${basePath}/products.xlsx`,
      kits: `${basePath}/kits.xlsx`,
    };
    const uploads = await Promise.all([
      admin.storage.from("upseller-imports").upload(paths.stock, stock, { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", upsert: false }),
      admin.storage.from("upseller-imports").upload(paths.relationships, relationships, { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", upsert: false }),
      admin.storage.from("upseller-imports").upload(paths.products, products, { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", upsert: false }),
      admin.storage.from("upseller-imports").upload(paths.kits, kits, { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", upsert: false }),
    ]);
    const uploadError = uploads.find((upload) => upload.error)?.error;
    if (uploadError) {
      await admin.storage.from("upseller-imports").remove(Object.values(paths));
      throw new Error(`UPS_STORAGE_UPLOAD_FAILED:${uploadError.message}`);
    }

    const previewSummary = {
      stockRows: parsed.summary.stockRows,
      stockUniqueSkus: parsed.summary.stockUniqueSkus,
      warehouses: parsed.summary.warehouses,
      productRows: parsed.summary.productRows,
      productUniqueSkus: parsed.summary.productUniqueSkus,
      relationshipRows: parsed.summary.relationshipRows,
      relationshipUniqueSkus: parsed.summary.relationshipUniqueSkus,
      relationshipStoreNames: parsed.summary.relationshipStoreNames,
      unknownStores: parsed.summary.unknownStores,
      blankRelationships: parsed.summary.blankRelationships,
      aliasRelationshipRows: parsed.summary.aliasRelationshipRows,
      kitRows: parsed.summary.kitRows,
      kitCount: parsed.summary.kitCount,
      kitComponentCount: parsed.summary.kitComponentCount,
      kitMissingStockComponents: parsed.summary.kitMissingStockComponents,
      derivedKitCount: parsed.summary.derivedKitCount,
      unresolvedDottedKitCount: parsed.summary.unresolvedDottedKitCount,
    };
    const validationIssues = {
      blockingIssues: parsed.summary.blockingIssues,
      warnings: parsed.summary.warnings,
    };
    const { error: insertError } = await admin.from("upseller_import_batches").insert({
      id: importId,
      organization_id: authorization.access.organizationId,
      status: "previewed",
      import_fingerprint: importFingerprint,
      stock_file_hash: stockHash,
      relationship_file_hash: relationshipHash,
      product_file_hash: productHash,
      kit_file_hash: kitHash,
      stock_storage_path: paths.stock,
      relationship_storage_path: paths.relationships,
      product_storage_path: paths.products,
      kit_storage_path: paths.kits,
      phase: "preview",
      preview_summary: previewSummary,
      validation_issues: validationIssues,
      requested_by: authorization.access.userId,
    });
    if (insertError) {
      await admin.storage.from("upseller-imports").remove(Object.values(paths));
      throw new Error(`UPS_IMPORT_CREATE_FAILED:${insertError.message}`);
    }
    return NextResponse.json({ importId, status: "previewed", ...previewSummary, ...validationIssues, duplicateImport: false });
  } catch (error) {
    console.error("UpSeller preview failed:", error instanceof Error ? error.message.slice(0, 500) : "unknown_error");
    return errorResponse(error);
  }
}
