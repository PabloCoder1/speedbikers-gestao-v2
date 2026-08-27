import type {
  AccountReconcileScheduleDeps,
  AccountReconcileScheduleOutcome,
} from "./account-reconcile-schedule.js";
import { triggerAccountReconcile } from "./account-reconcile-schedule.js";

/**
 * Gatilho da reconciliação de Perguntas (D-089) — chamado pelo Cloud
 * Scheduler, por CONTA (pergunta pertence a uma conta Mercado Livre
 * específica). A mecânica de dedupe/janela vive em
 * `account-reconcile-schedule.ts`, compartilhada com Mensagens pós-venda.
 *
 * **Cadência de 10 em 10 minutos** — era de 6 em 6 horas até 2026-08-26
 * (D-092). O raciocínio original ("o webhook entrega em segundos, isto aqui é
 * só a rede de segurança") dependia de uma premissa que D-091 derrubou: **o
 * webhook nunca foi chamado**. Enquanto o painel do Mercado Livre não for
 * configurado, esta varredura não é a rede — é o ÚNICO caminho de ingestão de
 * Perguntas. Com 6h, uma pergunta podia levar seis horas para aparecer na
 * Caixa de Entrada; com 10 minutos, leva no máximo dez.
 *
 * Custo modesto: 4 contas x 6 execuções/hora = 24 chamadas/hora, cada uma uma
 * página pequena filtrada por `UNANSWERED`. Para comparação, a sincronização
 * de visitas faz ~945 chamadas por conta por execução. Quando o webhook
 * estiver no ar, esta cadência pode voltar a ser folgada — mas aí será uma
 * decisão tomada com o caminho principal funcionando de verdade, não uma
 * suposição sobre ele.
 */

export type SupportQuestionsScheduleDeps = AccountReconcileScheduleDeps;
export type SupportQuestionsScheduleOutcome = AccountReconcileScheduleOutcome;

export function triggerSupportQuestionsReconcile(
  deps: SupportQuestionsScheduleDeps,
): Promise<SupportQuestionsScheduleOutcome> {
  return triggerAccountReconcile(deps, {
    jobType: "sync.support.questions.reconcile",
    dedupePrefix: "support-questions",
    triggeredEvent: "support_questions_schedule_triggered",
    accountsNotListedEvent: "support_questions_schedule_accounts_not_listed",
  });
}
