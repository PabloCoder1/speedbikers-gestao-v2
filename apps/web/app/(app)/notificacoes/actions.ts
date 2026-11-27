"use server";

import { revalidatePath } from "next/cache";

import {
  notificationFamilyPrefix,
  resolveNotificationFamily,
  resolveNotificationSeverity,
} from "../../../lib/notification-filters";
import { createClient } from "../../../lib/supabase/server";

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
  /** Quantas linhas a escrita em lote marcou. `null` quando não se aplica. */
  marked: number | null;
}

export async function markNotificationRead(notificationId: string): Promise<NotificationActionResult> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("notification_recipients")
    .update({ read_at: new Date().toISOString() })
    .eq("notification_id", notificationId)
    .select("notification_id");

  if (error !== null) {
    return { ok: false, message: "Não foi possível marcar como lida.", marked: null };
  }

  if (data.length === 0) {
    return {
      ok: false,
      message: "A notificação não foi marcada. Ela pode não estar mais disponível ou seu acesso mudou. Atualize a página para conferir.",
      marked: null,
    };
  }

  revalidatePath("/notificacoes");

  return { ok: true, message: null, marked: data.length };
}

/**
 * O RECORTE COMO PARÂMETRO DA ESCRITA (D-393).
 *
 * **Por que a ação precisou mudar.** Até D-290 a tela tinha dois recortes
 * (todas / não lidas) e "marcar todas" queria dizer uma coisa só. Com
 * severidade, família e conta, o mesmo botão passaria a mentir: quem filtra
 * "Anúncio" e clica "marcar todas" apagaria também as críticas de estoque que
 * estava deixando por ler de propósito. E é o caso REAL da base —
 * `listing.available_quantity.changed` é 60,4% das 54.306 notificações do Dev;
 * o que se quer limpar é exatamente essa família, sem tocar no resto.
 *
 * A RPC `mark_notifications_read` aplica os filtros e a RLS do evento
 * nas ações em lote. Sem filtros, ela marca todas as notificações visíveis
 * ao usuário e devolve quantas foram alteradas.
 *
 * **Valor fora da lista RECUSA, nunca alarga.** Na tela, um `?severidade=xpto`
 * cai em "todas" e o pior que acontece é ver linhas demais. Aqui o mesmo
 * silêncio transformaria "marcar as críticas" em "marcar tudo", que é escrita
 * irreversível pela interface. Por isso o valor desconhecido volta como erro.
 */
export interface NotificationBulkScope {
  severity: string | null;
  family: string | null;
  account: string | null;
  /**
   * D-616 (C-69, D-491): a loja Shopee do recorte (`shopee_shops.id`). Vai à
   * RPC só com valor — o parâmetro não existe antes da migration
   * `20261020130000` (PGRST202) —, e nunca junto da conta: o evento tem uma
   * origem só, e a tela tira uma ao escolher a outra (D-604).
   */
  loja: string | null;
}

/** `ml_accounts.id` é UUID; qualquer outra coisa nem chega ao banco. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function markAllNotificationsRead(
  scope: NotificationBulkScope = { severity: null, family: null, account: null, loja: null },
): Promise<NotificationActionResult> {
  const severity = scope.severity === null ? null : resolveNotificationSeverity(scope.severity);
  const family = scope.family === null ? null : resolveNotificationFamily(scope.family);
  const account = scope.account;
  const loja = scope.loja;

  const recusa =
    (scope.severity !== null && severity === null) ||
    (scope.family !== null && family === null) ||
    (account !== null && !UUID.test(account)) ||
    (loja !== null && !UUID.test(loja)) ||
    // Conta e loja juntas não alcançam evento nenhum: recusar diz isso, em vez de "0 marcadas".
    (account !== null && loja !== null);

  if (recusa) {
    return { ok: false, message: "Recorte não reconhecido — nada foi marcado.", marked: null };
  }

  const supabase = await createClient();
  const semRecorte = severity === null && family === null && account === null && loja === null;

  const { data, error } = await supabase.rpc("mark_notifications_read", {
    p_severity: severity,
    p_event_type_prefix: family === null ? null : notificationFamilyPrefix(family),
    p_ml_account_id: account,
    ...(loja === null ? {} : { p_shopee_shop_id: loja }),
  });

  if (error !== null) {
    return {
      ok: false,
      message: semRecorte
        ? "Não foi possível marcar todas como lidas."
        : "Não foi possível marcar as notificações deste recorte.",
      marked: null,
    };
  }

  revalidatePath("/notificacoes");

  return { ok: true, message: null, marked: typeof data === "number" ? data : null };
}
