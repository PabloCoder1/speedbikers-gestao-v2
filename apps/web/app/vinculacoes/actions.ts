"use server";

import { revalidatePath } from "next/cache";

import type { ManualLinkFields } from "../../lib/manual-link";
import { describeExistingLink, describeShapeConflict, parseManualLink } from "../../lib/manual-link";
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

  // O `.error` do auth NÃO pode ser descartado: sessão expirada entre o
  // carregamento da página e o clique viraria "sua conta não está associada a
  // nenhuma organização" — mentira exata da classe que D-067 auditou.
  const { data: auth, error: authError } = await supabase.auth.getUser();
  const userId = auth.user?.id ?? null;

  if (authError !== null || userId === null) {
    return { ok: false, message: "Sua sessão expirou — entre de novo." };
  }

  // `.eq("user_id")` NÃO é redundante: a policy `organization_members_select_same_org`
  // devolve UMA LINHA POR COLEGA (é `is_member_of(organization_id)`, não "a sua
  // linha"), e o `maybeSingle` do postgrest-js vira PGRST116 com mais de uma.
  // Sem o filtro, esta ação falharia 100% das vezes em qualquer organização
  // com dois membros — justamente o público dela, já que a policy de escrita
  // aceita ADMIN, GESTOR e OPERADOR. O `.limit(1)` cobre o usuário em mais de
  // uma organização, caso que o comentário de `organization_members` declara
  // suportado; é a mesma escolha de `private.current_org_id()`.
  const membership = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (membership.error !== null) {
    return { ok: false, message: "Não foi possível confirmar sua organização — tente de novo." };
  }

  const organizationId = membership.data?.organization_id ?? null;

  if (organizationId === null) {
    return { ok: false, message: "Sua conta não está associada a nenhuma organização." };
  }

  // TODOS os vínculos deste anúncio, não só os da mesma forma. Os dois índices
  // únicos são PARCIAIS e disjuntos: "anúncio inteiro" e "variação X" nunca
  // colidem entre si no banco, então checar só a própria forma deixaria passar
  // um estado incoerente — e `ml-listings-fetch`/`ml-fulfillment-fetch`
  // enumeram justamente os vínculos SEM variação, atribuindo o estoque Full do
  // item ao SKU desse vínculo.
  const links = await supabase
    .from("sku_listing_links")
    .select("id, sku_id, variation_id, source, skus(sku)")
    .eq("ml_account_id", mlAccountId)
    .eq("ref_kind", "ITEM")
    .eq("item_id", itemId);

  if (links.error !== null) {
    return { ok: false, message: "Não foi possível verificar vínculos existentes — tente de novo." };
  }

  const mesmaForma = links.data.find((link) => link.variation_id === variationId);

  if (mesmaForma !== undefined) {
    if (mesmaForma.sku_id === skuId) {
      return { ok: false, message: "Este anúncio já está vinculado a esse mesmo SKU — nada a fazer." };
    }

    // `sku_id` é `not null` e o embed acompanha — o tipo gerado garante o
    // objeto. `describeExistingLink` ainda aceita `null` por conta própria.
    return {
      ok: false,
      message: describeExistingLink({ sku: mesmaForma.skus.sku, source: mesmaForma.source }),
    };
  }

  const misturaDeFormas =
    variationId === null
      ? links.data.some((link) => link.variation_id !== null)
      : links.data.some((link) => link.variation_id === null);

  if (misturaDeFormas) {
    return { ok: false, message: describeShapeConflict(variationId === null) };
  }

  // Candidato OPEN para a MESMA referência: vincular por aqui deixaria o
  // candidato aberto para sempre, porque só `resolve_link_candidate` o fecha.
  const candidatoQuery = supabase
    .from("link_candidates")
    .select("id")
    .eq("ml_account_id", mlAccountId)
    .eq("ref_kind", "ITEM")
    .eq("item_id", itemId)
    .eq("status", "OPEN");

  const candidato = await (variationId === null
    ? candidatoQuery.is("variation_id", null)
    : candidatoQuery.eq("variation_id", variationId)
  ).limit(1);

  if (candidato.error !== null) {
    return { ok: false, message: "Não foi possível verificar a fila de candidatos — tente de novo." };
  }

  if (candidato.data.length > 0) {
    return {
      ok: false,
      message:
        "Este anúncio já está na lista abaixo como candidato. Use o botão da própria linha — assim o candidato é fechado na mesma transação, em vez de ficar aberto para sempre.",
    };
  }

  const { error } = await supabase.from("sku_listing_links").insert({
    organization_id: organizationId,
    ml_account_id: mlAccountId,
    ref_kind: "ITEM",
    item_id: itemId,
    variation_id: variationId,
    sku_id: skuId,
    source: "MANUAL",
    confirmed_by: userId,
    confirmed_at: new Date().toISOString(),
  });

  if (error !== null) {
    // A checagem acima tem janela: duas pessoas vinculando o mesmo anúncio ao
    // mesmo tempo chegam aqui. O índice parcial é quem decide, e o perdedor
    // recebe a mesma explicação em vez de "erro desconhecido".
    if (error.code === "23505") {
      return { ok: false, message: "Outra pessoa vinculou este anúncio agora mesmo — recarregue a página." };
    }

    if (error.message.includes("outra organizacao")) {
      return { ok: false, message: "SKU e conta precisam ser da mesma organização." };
    }

    if (error.code === "42501") {
      return { ok: false, message: "Você não tem permissão para vincular nesta conta." };
    }

    return { ok: false, message: "Não foi possível criar o vínculo." };
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
