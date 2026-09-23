"use server";

import { revalidatePath } from "next/cache";

import {
  notificationFamilyPrefix,
  resolveNotificationFamily,
  resolveNotificationSeverity,
} from "../../lib/notification-filters";
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
  /** Quantas linhas a escrita em lote marcou. `null` quando não se aplica. */
  marked: number | null;
}

export async function markNotificationRead(notificationId: string): Promise<NotificationActionResult> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("notification_recipients")
    .update({ read_at: new Date().toISOString() })
    .eq("notification_id", notificationId);

  if (error !== null) {
    return { ok: false, message: "Não foi possível marcar como lida.", marked: null };
  }

  revalidatePath("/notificacoes");

  return { ok: true, message: null, marked: 1 };
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
 * **Dois caminhos, e a divisão não é acidental.**
 *
 * - **Sem recorte** a escrita continua sendo a de sempre: `update` direto sob
 *   RLS, sem função. Além de ser o caminho já provado, ele é o que continua
 *   funcionando na PRÉVIA do PR — a CI nunca aplica migration em PR (D-025),
 *   então `mark_notifications_read` só existe no Dev depois do merge. Deixar o
 *   caso mais comum fora da dependência é o que impede a fatia de chegar com o
 *   botão principal quebrado.
 * - **Com recorte** quem escreve é `public.mark_notifications_read`
 *   (`security invoker`, migration `20260923170000`), porque o filtro mora num
 *   JOIN com `domain_events` e um `update` do PostgREST não junta tabela. A
 *   alternativa sem função seria ler as ids de mil em mil — o teto do
 *   PostgREST — e mandar catorze updates, com um teto para estourar em
 *   silêncio. É a classe de defeito de D-183, e não se repete aqui.
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
}

/** `ml_accounts.id` é UUID; qualquer outra coisa nem chega ao banco. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function markAllNotificationsRead(
  scope: NotificationBulkScope = { severity: null, family: null, account: null },
): Promise<NotificationActionResult> {
  const severity = scope.severity === null ? null : resolveNotificationSeverity(scope.severity);
  const family = scope.family === null ? null : resolveNotificationFamily(scope.family);
  const account = scope.account;

  const recusa =
    (scope.severity !== null && severity === null) ||
    (scope.family !== null && family === null) ||
    (account !== null && !UUID.test(account));

  if (recusa) {
    return { ok: false, message: "Recorte não reconhecido — nada foi marcado.", marked: null };
  }

  const supabase = await createClient();
  const semRecorte = severity === null && family === null && account === null;

  if (semRecorte) {
    const { error } = await supabase
      .from("notification_recipients")
      .update({ read_at: new Date().toISOString() })
      .is("read_at", null);

    if (error !== null) {
      return { ok: false, message: "Não foi possível marcar todas como lidas.", marked: null };
    }

    revalidatePath("/notificacoes");

    // A contagem do caminho sem recorte não vem do banco: o `update` do
    // PostgREST não devolve linhas afetadas sem `returning`, e pedir o retorno
    // de milhares de linhas para contar seria pagar caro por um número que o
    // painel já recarrega. Quem chama mostra o número que tinha antes.
    return { ok: true, message: null, marked: null };
  }

  const { data, error } = await supabase.rpc("mark_notifications_read", {
    p_severity: severity,
    p_event_type_prefix: family === null ? null : notificationFamilyPrefix(family),
    p_ml_account_id: account,
  });

  if (error !== null) {
    return { ok: false, message: "Não foi possível marcar as notificações deste recorte.", marked: null };
  }

  revalidatePath("/notificacoes");

  return { ok: true, message: null, marked: typeof data === "number" ? data : null };
}
