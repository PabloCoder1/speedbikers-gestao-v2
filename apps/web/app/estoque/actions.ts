"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "../../lib/supabase/server";
import { currentMembership } from "../../lib/membership";

/**
 * Ajuste manual de estoque (Fase 4, docs/ROADMAP.md) — Server Action chamando
 * `create_manual_stock_adjustment` (`security definer`), mesmo padrão de
 * `compras/actions.ts`. Autorização (ADMIN/GESTOR) e a escrita em
 * `stock_movements` vivem inteiramente na RPC.
 */

export interface ActionResult {
  ok: boolean;
  message: string | null;
}

function describeRpcError(error: { message: string } | null): string | null {
  if (error === null) return null;

  if (error.message.includes("sem permissao")) {
    return "Você não tem permissão para ajustar estoque — só ADMIN e GESTOR podem.";
  }

  if (error.message.includes("outra organizacao")) {
    return "Esse SKU pertence a outra organização.";
  }

  if (error.message.includes("exige um motivo")) {
    return "Informe o motivo do ajuste.";
  }

  if (error.message.includes("stock_movements_qty_delta_check")) {
    return "A quantidade do ajuste não pode ser zero.";
  }

  return "Não foi possível concluir o ajuste.";
}

async function currentOrganizationId(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ organizationId: string | null; failed: boolean }> {
  const membership = await currentMembership(supabase);

  if (membership.error !== null) {
    // Distinto de "sem organização" — falha de leitura transitória, não
    // problema de cadastro (D-067, Nível 3).
    return { organizationId: null, failed: true };
  }

  return { organizationId: membership.organizationId, failed: false };
}

export async function createManualStockAdjustment(input: {
  skuId: string;
  locationKind: "LOCAL" | "RESERVADO" | "TRANSITO";
  qtyDelta: number;
  reason: string;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const { organizationId, failed } = await currentOrganizationId(supabase);

  if (failed) {
    return { ok: false, message: "Não foi possível confirmar sua organização — tente de novo." };
  }

  if (organizationId === null) {
    return { ok: false, message: "Sua conta não está associada a nenhuma organização." };
  }

  const { error } = await supabase.rpc("create_manual_stock_adjustment", {
    p_organization_id: organizationId,
    p_sku_id: input.skuId,
    p_location_kind: input.locationKind,
    p_qty_delta: input.qtyDelta,
    p_reason: input.reason,
  });

  const message = describeRpcError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath("/estoque");

  return { ok: true, message: null };
}
