"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "../lib/supabase/server";

/**
 * Filtros salvos (Fase 5B, "Busca Universal / Command Palette e Filtros
 * salvos" — metade separada em D-060) — Server Actions (D-012), mesmo
 * padrão de `apps/web/app/vinculacoes/actions.ts`: escrita simples no
 * escopo do usuário, sem segredo, só chama a RPC. `screen` é o PATHNAME da
 * tela (ex.: `/vendas`) — dobra como chave de agrupamento e como alvo de
 * `revalidatePath`, sem precisar de um mapa separado.
 */

export interface ActionResult {
  ok: boolean;
  message: string | null;
}

export async function saveFilter(
  organizationId: string,
  screen: string,
  name: string,
  params: Record<string, string>,
): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("create_saved_filter", {
    p_organization_id: organizationId,
    p_screen: screen,
    p_name: name,
    p_params: params,
  });

  if (error !== null) {
    return { ok: false, message: "Não foi possível salvar o filtro." };
  }

  revalidatePath(screen);

  return { ok: true, message: null };
}

export async function deleteFilter(id: string, screen: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("delete_saved_filter", { p_id: id });

  if (error !== null) {
    return { ok: false, message: "Não foi possível apagar o filtro." };
  }

  revalidatePath(screen);

  return { ok: true, message: null };
}
