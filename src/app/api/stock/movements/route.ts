import { NextResponse } from "next/server";

import { getStockMutationAccess } from "@/features/auth/get-stock-mutation-access";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_KINDS = new Set(["manual_exit", "manual_entry", "adjustment"]);
const MAX_QUANTITY = 1_000_000;

export async function POST(request: Request) {
  const authorization = await getStockMutationAccess();
  if (!authorization.access) {
    return NextResponse.json({ error: "not_authorized" }, { status: authorization.status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const sku = typeof input.sku === "string" ? input.sku.trim() : "";
  const quantity = Number(input.quantity);
  const kind = typeof input.kind === "string" ? input.kind : "manual_exit";
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 120) : null;
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : null;

  if (!sku || sku.length > 120) {
    return NextResponse.json({ error: "invalid_sku" }, { status: 400 });
  }
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) {
    return NextResponse.json({ error: "invalid_quantity" }, { status: 400 });
  }
  if (!ALLOWED_KINDS.has(kind)) {
    return NextResponse.json({ error: "invalid_kind" }, { status: 400 });
  }

  /*
   * Cliente da sessão, não o privilegiado: a RPC é security definer e
   * valida a organização pelo próprio usuário autenticado.
   */
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("register_stock_movement", {
    target_organization_id: authorization.access.organizationId,
    target_sku: sku,
    requested_quantity: quantity,
    requested_kind: kind,
    requested_reason: reason,
    requested_note: note,
  });

  if (error) {
    const known = new Set(["sku_not_found", "invalid_quantity", "invalid_movement_kind"]);
    const code = known.has(error.message) ? error.message : "stock_movement_failed";
    if (!known.has(error.message)) {
      console.error("Stock movement failed:", error.message.slice(0, 500));
    }
    return NextResponse.json({ error: code }, { status: known.has(error.message) ? 400 : 500 });
  }

  return NextResponse.json({ ok: true, movement: data });
}
