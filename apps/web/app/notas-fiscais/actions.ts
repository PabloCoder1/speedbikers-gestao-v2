"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "../../lib/supabase/server";

/**
 * Vínculo humano de item de NF-e a SKU — tela de conferência.
 *
 * Server Action (D-012, docs/ARCHITECTURE.md secao 4): escrita simples no
 * escopo do usuário, sem segredo e sem trabalho longo. Só chama a RPC — toda
 * decisão de autorização e a atualização de `documents.resolved_items` vivem
 * dentro dela, na mesma transação
 * (`supabase/migrations/20260822160000_create_link_document_item_rpc.sql`).
 */

export interface ActionResult {
  ok: boolean;
  message: string | null;
}

function describeRpcError(error: { message: string } | null): string | null {
  if (error === null) return null;

  if (error.message.includes("sem permissao")) {
    return "Você não tem permissão para vincular itens nesta nota.";
  }

  if (error.message.includes("nao esta em conferencia")) {
    return "Esta nota já saiu da conferência — não é mais possível alterar o vínculo.";
  }

  if (error.message.includes("outra organizacao")) {
    return "Esse SKU pertence a outra organização.";
  }

  return "Não foi possível concluir a ação.";
}

export async function linkDocumentItem(
  itemId: number,
  skuId: string | null,
  documentId: string,
): Promise<ActionResult> {
  const supabase = await createClient();

  // O tipo gerado da RPC não aceita `null` (`p_sku_id?: string`) porque o
  // gerador não expressa nulidade de argumento escalar — só omite quando há
  // `default`. OMITIR a chave produz o MESMO efeito de passar NULL
  // explícito: o corpo da chamada não leva `p_sku_id`, e a função usa o
  // próprio `default null` do lado do Postgres. `exactOptionalPropertyTypes`
  // exige a chave de fato ausente, não `undefined` atribuído — daí o spread
  // condicional em vez de `p_sku_id: skuId ?? undefined`.
  const { error } = await supabase.rpc("link_document_item", {
    p_item_id: itemId,
    ...(skuId !== null ? { p_sku_id: skuId } : {}),
  });

  const message = describeRpcError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath(`/notas-fiscais/${documentId}`);

  return { ok: true, message: null };
}
