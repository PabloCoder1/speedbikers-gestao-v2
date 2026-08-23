import { NextResponse } from "next/server";

import { createClient } from "../../../../../lib/supabase/server";
import { loadPurchaseOrderExportData } from "../load";
import { buildPurchaseOrderWorkbook } from "../workbook";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const supabase = await createClient();
  const data = await loadPurchaseOrderExportData(supabase, id);

  if (data === null) {
    return NextResponse.json({ error: { code: "not_found" } }, { status: 404 });
  }

  const buffer = await buildPurchaseOrderWorkbook(data);

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="pedido-de-compra-${String(data.orderNumber)}.xlsx"`,
    },
  });
}
