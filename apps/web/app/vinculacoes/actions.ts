"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "../../lib/supabase/server";

/**
 * Confirmação humana da Central de Vinculações.
 *
 * Server Action (D-012, docs/ARCHITECTURE.md secao 4): escrita simples no
 * escopo do usuário, sem segredo e sem trabalho longo. Só chama a RPC — toda
 * decisão de autorização e a escrita nas duas tabelas (`sku_listing_links` e
 * `link_candidates`) vivem dentro dela, na mesma transação
 * (`supabase/migrations/20260821000000_create_link_candidates.sql`).
 */

export interface ActionResult {
  ok: boolean;
  message: string | null;
}

function describeRpcError(error: { message: string } | null): string | null {
  if (error === null) return null;

  if (error.message.includes("sem permissao")) {
    return "Você não tem permissão para vincular nesta conta.";
  }

  if (error.message.includes("nao esta aberto")) {
    return "Este candidato já foi resolvido ou descartado por outra pessoa.";
  }

  if (error.message.includes("outra organizacao")) {
    return "Esse SKU pertence a outra organização.";
  }

  return "Não foi possível concluir a ação.";
}

export async function resolveLinkCandidate(candidateId: string, skuId: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("resolve_link_candidate", {
    p_candidate_id: candidateId,
    p_sku_id: skuId,
  });

  const message = describeRpcError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath("/vinculacoes");

  return { ok: true, message: null };
}

export async function dismissLinkCandidate(candidateId: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("dismiss_link_candidate", { p_candidate_id: candidateId });

  const message = describeRpcError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath("/vinculacoes");

  return { ok: true, message: null };
}
