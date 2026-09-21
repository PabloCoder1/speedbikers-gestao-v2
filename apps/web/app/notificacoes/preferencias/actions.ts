"use server";

import { EVENT_SEVERITY } from "@sb/domain";
import { revalidatePath } from "next/cache";

import { createClient } from "../../../lib/supabase/server";

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

const SEVERITIES = new Set(["informativo", "importante", "critico"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validEventType(value: string | null): boolean {
  return value === null || Object.hasOwn(EVENT_SEVERITY, value);
}

function validSeverity(value: string): boolean {
  return SEVERITIES.has(value);
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

  if (!validEventType(input.eventType) || !validSeverity(input.minSeverity)) {
    return { ok: false, message: "A preferência recebida não é válida. Atualize a página e tente de novo." };
  }

  if (input.mlAccountId !== null) {
    if (!UUID_PATTERN.test(input.mlAccountId)) {
      return { ok: false, message: "A conta selecionada não é válida." };
    }

    // A consulta roda sob RLS: `null` cobre tanto conta inexistente quanto
    // conta fora da organização/escopo do usuário, sem revelar qual caso foi.
    const { data: account, error: accountError } = await supabase
      .from("ml_accounts")
      .select("id")
      .eq("id", input.mlAccountId)
      .maybeSingle();

    if (accountError !== null || account === null) {
      return { ok: false, message: "A conta selecionada não está disponível para este usuário." };
    }
  }

  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;

  if (userId === undefined) {
    return { ok: false, message: "Sessão expirada — atualize a página e tente de novo." };
  }

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

  if (!UUID_PATTERN.test(id) || !validSeverity(input.minSeverity)) {
    return { ok: false, message: "A preferência recebida não é válida." };
  }

  const { data, error } = await supabase
    .from("notification_preferences")
    .update({ min_severity: input.minSeverity, enabled: input.enabled })
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error !== null || data === null) {
    return { ok: false, message: "Não foi possível atualizar a preferência." };
  }

  revalidatePath("/notificacoes/preferencias");

  return { ok: true, message: null };
}

export async function deletePreference(id: string): Promise<PreferenceActionResult> {
  const supabase = await createClient();

  if (!UUID_PATTERN.test(id)) {
    return { ok: false, message: "A preferência recebida não é válida." };
  }

  const { data, error } = await supabase
    .from("notification_preferences")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error !== null || data === null) {
    return { ok: false, message: "Não foi possível remover a preferência." };
  }

  revalidatePath("/notificacoes/preferencias");

  return { ok: true, message: null };
}
