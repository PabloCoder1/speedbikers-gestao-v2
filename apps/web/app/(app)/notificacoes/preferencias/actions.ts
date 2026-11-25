"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "../../../../lib/supabase/server";

/**
 * Preferências de notificação (Fase 7, item 6, D-076) — Server Actions
 * diretas sob RLS (`notification_preferences_all_own`), sem RPC: cada
 * usuário só gerencia a própria preferência, mesmo raciocínio de
 * `profiles_update_self` (`docs/NOTIFICATIONS.md` secao 6).
 *
 * Só governa a ENTREGA EM TEMPO REAL (toast) — a Central de Notificações
 * mostra tudo sempre, independente destas regras (correção D-076,
 * `docs/DECISIONS.md`).
 */

export interface PreferenceActionResult {
  ok: boolean;
  message: string | null;
}

function describeWriteError(error: { message: string; code?: string } | null): string | null {
  if (error === null) return null;

  if (error.code === "23505") {
    return "Já existe uma preferência para essa combinação de tipo de evento e conta — edite ou remova a existente em vez de criar outra.";
  }

  return "Não foi possível salvar a preferência.";
}

export async function createPreference(input: {
  eventType: string | null;
  mlAccountId: string | null;
  minSeverity: string;
  enabled: boolean;
}): Promise<PreferenceActionResult> {
  const supabase = await createClient();

  const { data: auth, error: authError } = await supabase.auth.getUser();

  if (authError !== null) {
    return {
      ok: false,
      message:
        authError.status === 401 || authError.status === 403 || authError.name === "AuthSessionMissingError"
          ? "Sessão expirada — atualize a página e tente de novo."
          : "Não foi possível confirmar sua sessão — tente de novo.",
    };
  }

  const userId = auth.user.id;

  const { error } = await supabase.from("notification_preferences").insert({
    user_id: userId,
    event_type: input.eventType,
    ml_account_id: input.mlAccountId,
    min_severity: input.minSeverity,
    enabled: input.enabled,
  });

  const message = describeWriteError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath("/notificacoes/preferencias");

  return { ok: true, message: null };
}

export async function updatePreference(
  id: string,
  input: { minSeverity: string; enabled: boolean },
): Promise<PreferenceActionResult> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("notification_preferences")
    .update({ min_severity: input.minSeverity, enabled: input.enabled })
    .eq("id", id)
    .select("id");

  if (error !== null) {
    return { ok: false, message: "Não foi possível atualizar a preferência." };
  }

  if (data.length === 0) {
    return {
      ok: false,
      message: "A preferência não foi alterada. Ela pode ter sido removida ou seu acesso mudou. Atualize a página para conferir.",
    };
  }

  revalidatePath("/notificacoes/preferencias");

  return { ok: true, message: null };
}

export async function deletePreference(id: string): Promise<PreferenceActionResult> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("notification_preferences")
    .delete()
    .eq("id", id)
    .select("id");

  if (error !== null) {
    return { ok: false, message: "Não foi possível remover a preferência." };
  }

  if (data.length === 0) {
    return {
      ok: false,
      message: "Nada foi removido. A preferência já pode ter sido removida ou seu acesso mudou. Atualize a página para conferir.",
    };
  }

  revalidatePath("/notificacoes/preferencias");

  return { ok: true, message: null };
}
