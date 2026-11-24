"use server";

import { revalidatePath } from "next/cache";

import type { CurationOutcome } from "../../../lib/sku-curation";
import { normalizeSupplierBrand, parseSelecao, parseVirtualDecision, summarizeCuration } from "../../../lib/sku-curation";
import { createClient } from "../../../lib/supabase/server";

/**
 * Curadoria do catálogo (D-133).
 *
 * Server Action fina, mesmo desenho de `/vinculacoes`: valida a forma na
 * fronteira (`lib/sku-curation.ts`), chama a RPC e traduz o erro. Nenhuma
 * decisão de autorização vive aqui — `skus` não tem policy de escrita e
 * `authenticated` só tem SELECT; quem autoriza é
 * `private.check_sku_curation_writer`, dentro da transação.
 *
 * O que muda em relação às Server Actions anteriores: estas escrevem em LOTE
 * e a RPC devolve o desfecho POR LINHA. `ActionResult` só sabe dizer sim ou
 * não, e isso não basta — "412 marcados" pode significar 8 se o filtro de
 * no-op tiver descartado o resto. Daí `CurationResult`, que é extensão
 * declarada, não improviso.
 */

export interface CurationResult {
  ok: boolean;
  message: string | null;
  outcome: CurationOutcome | null;
}

/**
 * Tradução por FRAGMENTO sem acento — as exceções da RPC são escritas assim
 * de propósito, para o casamento não depender de codificação.
 */
function describeCuracaoError(error: { message: string } | null): string | null {
  if (error === null) return null;

  if (error.message.includes("sem permissao")) {
    return "Você não tem permissão para curar o catálogo desta organização.";
  }

  if (error.message.includes("selecao vazia")) {
    return "Selecione ao menos um SKU.";
  }

  if (error.message.includes("selecao grande demais")) {
    return "Selecione no máximo 500 SKUs por vez.";
  }

  if (error.message.includes("marca invalida")) {
    return "A marca precisa ter no máximo 60 caracteres.";
  }

  if (error.message.includes("decisao invalida")) {
    return "Decisão inválida.";
  }

  return "Não foi possível concluir a ação.";
}

const falha = (message: string): CurationResult => ({ ok: false, message, outcome: null });

export async function classifySkus(
  organizationId: string,
  skuIds: readonly string[],
  decision: string,
): Promise<CurationResult> {
  const selecao = parseSelecao(skuIds);

  if (!selecao.ok) return falha(selecao.message);

  const decisao = parseVirtualDecision(decision);

  if (!decisao.ok) return falha(decisao.message);

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("set_skus_stock_virtual", {
    p_organization_id: organizationId,
    p_sku_ids: selecao.value,
    p_decision: decisao.value,
  });

  const message = describeCuracaoError(error);

  if (message !== null) return falha(message);

  const outcome = summarizeCuration(data ?? []);

  // Só no caminho de sucesso: revalidar depois do erro seria trabalho jogado
  // fora, e antes do sucesso seria mentira na tela.
  revalidatePath("/produtos");

  // `/reposicao` lê `stock_is_virtual` para RECUSAR cobertura (D-127), então
  // ela fica errada até revalidar. É a tela onde a consequência aparece —
  // desde a fusão de D-288 ela é a única: `/cobertura` virou redirect, e
  // revalidar um redirect não atualiza nada.
  revalidatePath("/reposicao");

  return { ok: true, message: null, outcome };
}

export async function setSupplierBrand(
  organizationId: string,
  skuIds: readonly string[],
  rawBrand: string,
): Promise<CurationResult> {
  const selecao = parseSelecao(skuIds);

  if (!selecao.ok) return falha(selecao.message);

  const marca = normalizeSupplierBrand(rawBrand);

  if (!marca.ok) return falha(marca.message);

  const supabase = await createClient();

  // `p_supplier_brand` vai SEMPRE explícito, nunca por spread condicional: o
  // parâmetro não tem default no SQL, e omitir a chave por engano — o risco
  // real com `exactOptionalPropertyTypes` — apagaria a marca de até 500 SKUs.
  const { data, error } = await supabase.rpc("set_skus_supplier_brand", {
    p_organization_id: organizationId,
    p_sku_ids: selecao.value,
    p_supplier_brand: marca.value,
  });

  const message = describeCuracaoError(error);

  if (message !== null) return falha(message);

  const outcome = summarizeCuration(data ?? []);

  revalidatePath("/produtos");

  return { ok: true, message: null, outcome };
}

/**
 * D-860: marca (`fora` verdadeiro) ou tira à mão a marca de FORA DO CATÁLOGO.
 * Nada é apagado: o SKU fica inativo, sai da Reposição e das sugestões de
 * compra, e o histórico continua. A marca manual não sai com a planilha.
 */
export async function setForaDoCatalogo(
  organizationId: string,
  skuIds: readonly string[],
  fora: boolean,
): Promise<CurationResult> {
  const selecao = parseSelecao(skuIds);

  if (!selecao.ok) return falha(selecao.message);

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("set_skus_out_of_catalog", {
    p_organization_id: organizationId,
    p_sku_ids: selecao.value,
    p_out: fora,
  });

  const message = describeCuracaoError(error);

  if (message !== null) return falha(message);

  const outcome = summarizeCuration(data ?? []);

  revalidatePath("/produtos");
  // A Reposição deixa de fora o SKU marcado (D-860): é onde a marca pesa.
  revalidatePath("/reposicao");

  return { ok: true, message: null, outcome };
}
