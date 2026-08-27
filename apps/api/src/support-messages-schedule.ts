import type {
  AccountReconcileScheduleDeps,
  AccountReconcileScheduleOutcome,
} from "./account-reconcile-schedule.js";
import { triggerAccountReconcile } from "./account-reconcile-schedule.js";

/**
 * Gatilho da reconciliação de Mensagens pós-venda — chamado pelo Cloud
 * Scheduler, por CONTA, com a mesma mecânica de dedupe/janela de Perguntas.
 *
 * **Cadência de 10 em 10 minutos**, igual à de Perguntas e pelo mesmo motivo
 * medido: o webhook do Mercado Livre nunca chegou a ser chamado (D-091),
 * porque o painel de notificações nunca foi configurado. Enquanto isso for
 * verdade, esta varredura não é rede de segurança — é a ÚNICA porta por onde
 * uma mensagem pós-venda entra no sistema.
 *
 * Custo por execução: 1 chamada a `/messages/unread` por conta, mais 1 por
 * conversa não lida. Com 4 contas são 24 chamadas/hora de base; o teto de 120
 * conversas por execução do handler impede que uma conta com backlog grande
 * consuma o pool compartilhado de 500 rpm da mensageria e prejudique os outros
 * syncs.
 */

export type SupportMessagesScheduleDeps = AccountReconcileScheduleDeps;
export type SupportMessagesScheduleOutcome = AccountReconcileScheduleOutcome;

export function triggerSupportMessagesReconcile(
  deps: SupportMessagesScheduleDeps,
): Promise<SupportMessagesScheduleOutcome> {
  return triggerAccountReconcile(deps, {
    jobType: "sync.support.messages.reconcile",
    dedupePrefix: "support-messages",
    triggeredEvent: "support_messages_schedule_triggered",
    accountsNotListedEvent: "support_messages_schedule_accounts_not_listed",
  });
}
