import { NextResponse } from "next/server";

import { getStockMutationAccess } from "@/features/auth/get-stock-mutation-access";
import {
  MAX_NFE_XML_BYTES,
  NfeXmlError,
} from "@/features/stock/nfe-parser";
import { resolveNfeStockReceipt } from "@/features/stock/resolve-nfe-stock-receipt";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = MAX_NFE_XML_BYTES + 256 * 1024;

export async function POST(request: Request) {
  const authorization = await getStockMutationAccess();
  if (!authorization.access) {
    return NextResponse.json({ error: "not_authorized" }, { status: authorization.status });
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "xml_too_large" }, { status: 413 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("xml");
    const warehouseKey = formData.get("warehouseKey");
    const recipientConfirmed = formData.get("recipientConfirmed");
    if (
      !(file instanceof File) ||
      file.size === 0 ||
      file.size > MAX_NFE_XML_BYTES ||
      typeof warehouseKey !== "string"
    ) {
      return NextResponse.json({ error: "invalid_receipt_files" }, { status: 400 });
    }
    if (recipientConfirmed !== "true") {
      return NextResponse.json({ error: "recipient_confirmation_required" }, { status: 400 });
    }

    const xmlBuffer = Buffer.from(await file.arrayBuffer());
    const resolution = await resolveNfeStockReceipt({
      organizationId: authorization.access.organizationId,
      warehouseKey,
      xmlBuffer,
    });

    if (resolution.blockingIssues.length > 0 || !resolution.warehouse) {
      return NextResponse.json(
        { error: "stock_receipt_has_blocking_issues", blockingIssues: resolution.blockingIssues },
        { status: 422 },
      );
    }

    const resolvedItems = resolution.items.flatMap((item) => (
      item.matched && item.productId && item.stockStateId && item.baselineImportId
        ? [{
            lineNumber: item.lineNumber,
            productId: item.productId,
            skuKey: item.skuKey,
            description: item.description,
            unit: item.unit,
            quantity: item.quantity,
            unitValue: item.unitValue,
            totalValue: item.totalValue,
            baselineImportId: item.baselineImportId,
          }]
        : []
    ));

    if (resolvedItems.length !== resolution.items.length) {
      return NextResponse.json({ error: "stock_receipt_resolution_changed" }, { status: 409 });
    }

    const admin = createAdminClient();
    const { data: receiptId, error } = await admin.rpc("apply_nfe_stock_receipt", {
      target_organization_id: authorization.access.organizationId,
      target_received_by: authorization.access.userId,
      receipt_payload: {
        accessKey: resolution.invoice.accessKey,
        invoiceNumber: resolution.invoice.invoiceNumber,
        invoiceSeries: resolution.invoice.invoiceSeries,
        issuedAt: resolution.invoice.issuedAt,
        protocolStatus: resolution.invoice.protocolStatus,
        supplierName: resolution.invoice.supplierName,
        supplierDocument: resolution.invoice.supplierDocument,
        recipientDocument: resolution.invoice.recipientDocument,
        totalAmount: resolution.invoice.totalAmount,
        warehouseName: resolution.warehouse.name,
        warehouseKey: resolution.warehouse.key,
        sourceSha256: resolution.sourceSha256,
      },
      items_payload: resolvedItems,
    });

    if (error) {
      const duplicate = error.code === "23505" || error.message.includes("duplicate key");
      const changed = error.message.includes("stock_changed_since_receipt_preview");
      console.error("NF-e stock receipt commit failed:", error.message.slice(0, 500));
      return NextResponse.json(
        { error: duplicate ? "duplicate_invoice" : changed ? "stock_changed_since_preview" : "stock_receipt_commit_failed" },
        { status: duplicate || changed ? 409 : 500 },
      );
    }

    return NextResponse.json({
      receiptId,
      invoiceNumber: resolution.invoice.invoiceNumber,
      itemCount: resolution.items.length,
      totalQuantity: resolution.totalQuantity,
      warehouseName: resolution.warehouse.name,
    });
  } catch (error) {
    if (error instanceof NfeXmlError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: 400 },
      );
    }
    console.error(
      "NF-e stock receipt commit failed:",
      error instanceof Error ? error.message.slice(0, 500) : "unknown_error",
    );
    return NextResponse.json({ error: "stock_receipt_commit_failed" }, { status: 500 });
  }
}
