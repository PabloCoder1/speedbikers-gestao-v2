"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "../../lib/supabase/server";
import { currentMembership } from "../../lib/membership";
import {
  ADJUSTMENT_REASONS,
  NOTE_MAX,
  REFERENCE_MAX,
  adjustmentDelta,
  composeAdjustmentReason,
  isAdjustmentLocation,
  isAdjustmentMode,
  type AdjustmentLocation,
  type AdjustmentMode,
} from "../../lib/stock-adjustment";

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

export interface AdjustmentResult extends ActionResult {
  /** O delta efetivamente gravado — no balanço, só o servidor sabe. */
  delta: number | null;
}

export async function createManualStockAdjustment(input: {
  skuId: string;
  locationKind: AdjustmentLocation;
  mode: AdjustmentMode;
  /** Sempre positiva: unidades movidas (entrada/saída) ou saldo contado (balanço). */
  quantity: number;
  category: string;
  reference: string;
  note: string;
}): Promise<AdjustmentResult> {
  if (
    !isAdjustmentMode(input.mode) ||
    !isAdjustmentLocation(input.locationKind) ||
    !Number.isSafeInteger(input.quantity) ||
    input.quantity < 0 ||
    typeof input.category !== "string" ||
    !ADJUSTMENT_REASONS[input.mode].includes(input.category) ||
    typeof input.reference !== "string" ||
    input.reference.length > REFERENCE_MAX ||
    typeof input.note !== "string" ||
    input.note.length > NOTE_MAX
  ) {
    return { ok: false, message: "Confira a operação, o local, a quantidade e o motivo.", delta: null };
  }

  const supabase = await createClient();
  const { organizationId, failed } = await currentOrganizationId(supabase);

  if (failed) {
    return { ok: false, message: "Não foi possível confirmar sua organização — tente de novo.", delta: null };
  }

  if (organizationId === null) {
    return { ok: false, message: "Sua conta não está associada a nenhuma organização.", delta: null };
  }

  // Balanço: a diferença é calculada contra o saldo lido AGORA, não contra o
  // que a tela mostrou ao abrir — uma venda no meio do caminho não vira erro
  // de contagem.
  let currentBalance = 0;

  if (input.mode === "BALANCO") {
    const saldo = await supabase
      .from("inventory_balances")
      .select("quantity")
      .eq("organization_id", organizationId)
      .eq("sku_id", input.skuId)
      .eq("location_kind", input.locationKind)
      .maybeSingle();

    if (saldo.error !== null) {
      return { ok: false, message: "Não foi possível ler o saldo atual para o balanço — tente de novo.", delta: null };
    }

    currentBalance = saldo.data?.quantity ?? 0;
  }

  const delta = adjustmentDelta(input.mode, input.quantity, currentBalance);

  if (delta === null) {
    return {
      ok: false,
      message:
        input.mode === "BALANCO"
          ? "O saldo contado é igual ao saldo do sistema — não há diferença para ajustar."
          : "Informe uma quantidade maior que zero.",
      delta: null,
    };
  }

  const { error } = await supabase.rpc("create_manual_stock_adjustment", {
    p_organization_id: organizationId,
    p_sku_id: input.skuId,
    p_location_kind: input.locationKind,
    p_qty_delta: delta,
    p_reason: composeAdjustmentReason(input.mode, input.category, input.reference, input.note),
  });

  const message = describeRpcError(error);

  if (message !== null) {
    return { ok: false, message, delta: null };
  }

  revalidatePath("/estoque");
  revalidatePath(`/estoque/${input.skuId}/ajuste`);

  return { ok: true, message: null, delta };
}
