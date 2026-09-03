"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "../../../lib/supabase/server";
import { currentMembership } from "../../../lib/membership";

/**
 * Base de Conhecimento Validada (D-113) — Server Actions sob RLS.
 *
 * Qualquer membro SUGERE (a policy força `status = 'SUGERIDO'` no insert);
 * só ADMIN/GESTOR mudam status. A validação é o ato que transforma opinião
 * em evidência do Copiloto — por isso ela exige quem/quando (constraint
 * `knowledge_entries_validation_coherent`).
 */

export const KNOWLEDGE_KINDS = ["COMPATIBILIDADE", "ESPECIFICACAO", "POLITICA", "OUTRO"] as const;
export const KNOWLEDGE_SOURCES = ["CONFIRMACAO_INTERNA", "FABRICANTE", "DOCUMENTACAO", "ATENDIMENTO"] as const;

export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export type KnowledgeSource = (typeof KNOWLEDGE_SOURCES)[number];

export interface KnowledgeActionResult {
  ok: boolean;
  message: string | null;
}

export async function createKnowledgeEntry(input: {
  kind: KnowledgeKind;
  source: KnowledgeSource;
  content: string;
  note: string;
  skuCode: string;
}): Promise<KnowledgeActionResult> {
  const content = input.content.trim();

  if (content.length === 0) {
    return { ok: false, message: "Escreva o fato a registrar." };
  }

  if (content.length > 500) {
    return { ok: false, message: "O fato passa de 500 caracteres — registre o essencial e use a observação." };
  }

  const supabase = await createClient();

  const [authResult, membershipResult] = await Promise.all([
    supabase.auth.getUser(),
    currentMembership(supabase),
  ]);

  const userId = authResult.data.user?.id;
  const organizationId = membershipResult.organizationId;

  if (userId === undefined || organizationId === null) {
    return { ok: false, message: "Sessão expirada — atualize a página." };
  }

  // SKU por CÓDIGO, não por UUID: é como a operação se refere ao produto.
  // Código que não resolve é erro explícito — vincular ao SKU errado seria
  // pior que não vincular.
  let skuId: string | null = null;
  const skuCode = input.skuCode.trim();

  if (skuCode.length > 0) {
    const sku = await supabase.from("skus").select("id").eq("sku", skuCode).maybeSingle();

    if (sku.error !== null || sku.data === null) {
      return { ok: false, message: `SKU "${skuCode}" não encontrado.` };
    }

    skuId = sku.data.id;
  }

  const result = await supabase.from("knowledge_entries").insert({
    organization_id: organizationId,
    created_by: userId,
    sku_id: skuId,
    kind: input.kind,
    source: input.source,
    content,
    note: input.note.trim().length > 0 ? input.note.trim() : null,
  });

  if (result.error !== null) {
    return { ok: false, message: result.error.message };
  }

  revalidatePath("/atendimento/conhecimento");

  return { ok: true, message: null };
}

/**
 * VALIDAR preenche `confirmed_by`/`confirmed_at` (a constraint exige);
 * REJEITADO/OBSOLETO os limpam — a confirmação pertence ao estado validado,
 * não à linha.
 */
export async function setKnowledgeStatus(
  id: string,
  status: "VALIDADO" | "REJEITADO" | "OBSOLETO",
): Promise<KnowledgeActionResult> {
  const supabase = await createClient();

  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;

  if (userId === undefined) {
    return { ok: false, message: "Sessão expirada — atualize a página." };
  }

  const patch =
    status === "VALIDADO"
      ? { status, confirmed_by: userId, confirmed_at: new Date().toISOString() }
      : { status, confirmed_by: null, confirmed_at: null };

  const result = await supabase
    .from("knowledge_entries")
    .update(patch)
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (result.error !== null) {
    return { ok: false, message: result.error.message };
  }

  if (result.data === null) {
    return { ok: false, message: "Só ADMIN e GESTOR validam conhecimento." };
  }

  revalidatePath("/atendimento/conhecimento");

  return { ok: true, message: null };
}
