"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "../../lib/supabase/server";

/**
 * Central de Notificações (Fase 7, item 4, D-073 desbloqueou o schema) —
 * Server Action (D-012, `docs/ARCHITECTURE.md` secao 4, que cita nominalmente
 * "marcar notificação lida" como exemplo de escrita simples no escopo do
 * usuário): escreve direto em `notification_recipients` sob RLS, sem RPC —
 * a policy `notification_recipients_update_own` já restringe a atualização à
 * própria linha do usuário, então filtrar só por `notification_id` (sem
 * `user_id`) é seguro: a RLS descarta qualquer linha que não seja do usuário
 * corrente, mesmo que o filtro do cliente não a exclua explicitamente.
 */

export interface NotificationActionResult {
  ok: boolean;
  message: string | null;
}

export async function markNotificationRead(notificationId: string): Promise<NotificationActionResult> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("notification_recipients")
    .update({ read_at: new Date().toISOString() })
    .eq("notification_id", notificationId);

  if (error !== null) {
    return { ok: false, message: "Não foi possível marcar como lida." };
  }

  revalidatePath("/notificacoes");

  return { ok: true, message: null };
}

/** "Marcar todas como lidas" — mesma escrita, sem filtro de id: todas as não lidas do usuário. */
export async function markAllNotificationsRead(): Promise<NotificationActionResult> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("notification_recipients")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null);

  if (error !== null) {
    return { ok: false, message: "Não foi possível marcar todas como lidas." };
  }

  revalidatePath("/notificacoes");

  return { ok: true, message: null };
}
