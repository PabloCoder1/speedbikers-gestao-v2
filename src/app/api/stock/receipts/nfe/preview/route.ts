import { NextResponse } from "next/server";

import { getStockMutationAccess } from "@/features/auth/get-stock-mutation-access";
import {
  MAX_NFE_XML_BYTES,
  NfeXmlError,
} from "@/features/stock/nfe-parser";
import { resolveNfeStockReceipt } from "@/features/stock/resolve-nfe-stock-receipt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = MAX_NFE_XML_BYTES + 256 * 1024;

function errorResponse(error: unknown) {
  if (error instanceof NfeXmlError) {
    return NextResponse.json(
      { error: error.code, message: error.message },
      { status: 400 },
    );
  }
  if (error instanceof Error && error.message === "invalid_warehouse") {
    return NextResponse.json({ error: "invalid_warehouse" }, { status: 400 });
  }
  console.error(
    "NF-e stock receipt preview failed:",
    error instanceof Error ? error.message.slice(0, 500) : "unknown_error",
  );
  return NextResponse.json({ error: "stock_receipt_preview_failed" }, { status: 500 });
}

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

    if (
      !(file instanceof File) ||
      file.size === 0 ||
      file.size > MAX_NFE_XML_BYTES ||
      typeof warehouseKey !== "string"
    ) {
      return NextResponse.json({ error: "invalid_receipt_files" }, { status: 400 });
    }

    if (!file.name.toLocaleLowerCase("pt-BR").endsWith(".xml")) {
      return NextResponse.json({ error: "invalid_xml_file" }, { status: 400 });
    }

    const resolution = await resolveNfeStockReceipt({
      organizationId: authorization.access.organizationId,
      warehouseKey,
      xmlBuffer: Buffer.from(await file.arrayBuffer()),
    });

    return NextResponse.json({
      duplicate: resolution.duplicate,
      invoice: resolution.invoice,
      warehouse: resolution.warehouse,
      items: resolution.items.map((item) => ({
        lineNumber: item.lineNumber,
        supplierSku: item.supplierSku,
        description: item.description,
        unit: item.unit,
        quantity: item.quantity,
        unitValue: item.unitValue,
        totalValue: item.totalValue,
        matched: item.matched,
        productSku: item.productSku,
        productName: item.productName,
        issue: item.issue,
      })),
      blockingIssues: resolution.blockingIssues,
      totalQuantity: resolution.totalQuantity,
      matchedItemCount: resolution.matchedItemCount,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
