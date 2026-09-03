"use server";

import { revalidatePath } from "next/cache";

import type { SuggestionStatus } from "./constants";
import { createClient } from "../../lib/supabase/server";
import { currentMembership } from "../../lib/membership";

/**
 * Sugestões de features via Copiloto (Fase 7, item 9, D-079,
 * `docs/PRODUCT_REQUIREMENTS.md`) — Server Actions diretas sob RLS, sem
 * RPC: qualquer membro envia (`feature_suggestions_insert_own`), só
 * ADMIN/GESTOR muda o estado de triagem (`feature_suggestions_update_admin`).
 *
 * Sem estruturação por IA nesta fatia (schema pronto, sem UI de
 * preenchimento manual — ver `docs/DECISIONS.md` D-079): `original_text`
 * é a única coisa que esta tela grava.
 */

export interface SuggestionActionResult {
  ok: boolean;
  message: string | null;
}


export async function createSuggestion(originalText: string): Promise<SuggestionActionResult> {
  const trimmed = originalText.trim();

  if (trimmed.length === 0) {
    return { ok: false, message: "Escreva a sugestão antes de enviar." };
  }

  const supabase = await createClient();

  const [authResult, membershipResult] = await Promise.all([
    supabase.auth.getUser(),
    currentMembership(supabase),
  ]);

  const userId = authResult.data.user?.id;
  const organizationId = membershipResult.organizationId;

  if (userId === undefined || organizationId === null) {
    return { ok: false, message: "Sessão expirada ou sem organização — atualize a página e tente de novo." };
  }

  // `as never`: `feature_suggestions` ainda não existe em `Database`
  // (types.ts não regenerado — migration ainda não aplicou no Supabase
  // Dev quando este arquivo foi escrito, mesma situação já documentada em
  // D-073/D-077). Trocar para o tipo gerado assim que `types.ts` for
  // regenerado.
  const { error } = await supabase.from("feature_suggestions" as never).insert({
    organization_id: organizationId,
    created_by: userId,
    original_text: trimmed,
  } as never);

  if (error !== null) {
    return { ok: false, message: "Não foi possível enviar a sugestão." };
  }

  revalidatePath("/sugestoes");

  return { ok: true, message: null };
}

export async function updateSuggestionStatus(id: string, status: SuggestionStatus): Promise<SuggestionActionResult> {
  const supabase = await createClient();

  // `as never`: mesma situação temporária de `createSuggestion`, acima.
  const { error } = await supabase
    .from("feature_suggestions" as never)
    .update({ status } as never)
    .eq("id" as never, id);

  if (error !== null) {
    return { ok: false, message: "Não foi possível atualizar — só ADMIN/GESTOR muda o status." };
  }

  revalidatePath("/sugestoes");

  return { ok: true, message: null };
}
