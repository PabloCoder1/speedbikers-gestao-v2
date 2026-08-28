"use server";

import { revalidatePath } from "next/cache";

import type { ManualLinkFields } from "../../lib/manual-link";
import { parseManualLink } from "../../lib/manual-link";
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

/**
 * Vinculação manual livre, sem `link_candidate` prévio
 * (`docs/PRODUCT_REQUIREMENTS.md`; item P1 aberto desde o Checkpoint pré-Fase 7).
 *
 * Escrita DIRETA sob RLS, sem RPC — uma tabela só, sem transação
 * multi-tabela, mesmo padrão de `reply_templates` (D-111). A autorização é a
 * policy `sku_listing_links_write_permitted` (acesso à conta + papel), que
 * existe desde a Fase 2 e nunca teve um chamador: até aqui NENHUM código de
 * `apps/web` escrevia nesta tabela.
 *
 * `resolve_link_candidate` continua sendo RPC porque escreve em DUAS tabelas
 * na mesma transação. Aqui não há candidato para fechar.
 */
export async function createManualLink(fields: ManualLinkFields): Promise<ActionResult> {
  const parsed = parseManualLink(fields);

  if (!parsed.ok) {
    return { ok: false, message: parsed.message };
  }

  const { mlAccountId, itemId, variationId, skuId } = parsed.value;
  const supabase = await createClient();

  // RPC desde D-125, não mais escrita direta: a criação passou a gravar DUAS
  // tabelas na mesma transação (o vínculo e o evento ), que é o
  // próprio critério de D-119 para exigir RPC. E as três pré-checagens
  // (mesma forma, mistura de formas, candidato aberto) mudaram de lugar: eram
  // TOCTOU aqui fora, agora rodam dentro da transação. A escrita direta nem
  // seria possível —  perdeu INSERT/UPDATE/DELETE na tabela.
  const { error } = await supabase.rpc("create_sku_listing_link", {
    p_ml_account_id: mlAccountId,
    p_item_id: itemId,
    p_variation_id: variationId,
    p_sku_id: skuId,
  });

  const message = describeLinkRpcError(error);

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

/**
 * Traduz os erros das RPCs de vínculo (D-125). Cada fragmento corresponde a
 * um `raise exception` nomeado — nunca ao texto cru do Postgres.
 */
function describeLinkRpcError(error: { message: string; code?: string } | null): string | null {
  if (error === null) return null;

  if (error.message.includes("sem permissao")) {
    return "Você não tem permissão para operar vínculos nesta conta.";
  }

  if (error.message.includes("mistura de formas")) {
    return "Este anúncio já tem vínculo na outra forma (anúncio inteiro × variação). Misturar deixaria o estoque Full no SKU errado.";
  }

  if (error.message.includes("candidato aberto")) {
    return "Este anúncio já está na lista de candidatos abaixo. Use o botão da própria linha — assim o candidato é fechado na mesma transação.";
  }

  if (error.message.includes("outra organizacao")) {
    return "SKU e conta precisam ser da mesma organização.";
  }

  if (error.message.includes("motivo obrigatorio")) {
    return "Informe o motivo da remoção — ele fica no histórico.";
  }

  if (error.message.includes("ja aponta para este SKU")) {
    return "O vínculo já aponta para esse SKU — nada a fazer.";
  }

  if (error.message.includes("nao encontrado")) {
    return "Vínculo não encontrado. Outra pessoa pode tê-lo removido — recarregue a página.";
  }

  if (error.code === "23505") {
    return "Outra pessoa vinculou este anúncio agora mesmo — recarregue a página.";
  }

  return "Não foi possível concluir a ação.";
}

/** Troca o SKU de um vínculo PRESERVANDO o id — logo, preservando os ponteiros já gravados em `order_items` (D-125). */
export async function retargetLink(linkId: string, skuId: string, reason: string): Promise<ActionResult> {
  const supabase = await createClient();

  const motivo = reason.trim();

  const { error } = await supabase.rpc("retarget_sku_listing_link", {
    p_link_id: linkId,
    p_sku_id: skuId,
    // : omitir e diferente de mandar undefined.
    ...(motivo === "" ? {} : { p_reason: motivo }),
  });

  const message = describeLinkRpcError(error);

  if (message !== null) return { ok: false, message };

  revalidatePath("/vinculacoes");

  return { ok: true, message: null };
}

/**
 * Remove o vínculo. Operação SECUNDÁRIA de propósito: trocar o SKU
 * (`retargetLink`) preserva os ponteiros históricos; remover é para quando a
 * intenção real é "este anúncio não deve ter vínculo nenhum". O motivo é
 * obrigatório e fica no histórico.
 */
export async function removeLink(linkId: string, reason: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("remove_sku_listing_link", {
    p_link_id: linkId,
    p_reason: reason,
  });

  const message = describeLinkRpcError(error);

  if (message !== null) return { ok: false, message };

  revalidatePath("/vinculacoes");

  return { ok: true, message: null };
}
