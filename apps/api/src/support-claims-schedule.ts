import type {
  AccountReconcileScheduleDeps,
  AccountReconcileScheduleOutcome,
} from "./account-reconcile-schedule.js";
import { triggerAccountReconcile } from "./account-reconcile-schedule.js";

/**
 * Gatilho da reconciliação de Reclamações (D-108) — por CONTA, mesma mecânica
 * de dedupe/janela de Perguntas e Mensagens.
 *
 * **Cadência de 1 em 1 hora**, deliberadamente mais folgada que os 10 minutos
 * de Perguntas/Mensagens, por três razões medidas e não supostas:
 *
 * 1. **O webhook de claims FUNCIONA.** D-101 mediu `post_purchase` chegando de
 *    verdade. Aqui a varredura é rede de segurança, não o único caminho — que
 *    era exatamente a situação que forçou os 10 minutos em D-092.
 * 2. **Cada claim custa três chamadas** (envelope da busca + transcript +
 *    detalhe), contra uma única página em Perguntas. Cadência agressiva aqui
 *    multiplica por três.
 * 3. **A própria doc alerta para o custo.** Ela chama consultas amplas de
 *    reclamação de "extremamente custosas" e cita "risco de rate limiting ou
 *    bloqueio da aplicação". Uma hora respeita esse aviso sem deixar buraco
 *    operacional relevante: o webhook cobre os segundos.
 */

export type SupportClaimsScheduleDeps = AccountReconcileScheduleDeps;
export type SupportClaimsScheduleOutcome = AccountReconcileScheduleOutcome;

export function triggerSupportClaimsReconcile(
  deps: SupportClaimsScheduleDeps,
): Promise<SupportClaimsScheduleOutcome> {
  return triggerAccountReconcile(deps, {
    jobType: "sync.support.claims.reconcile",
    dedupePrefix: "support-claims",
    triggeredEvent: "support_claims_schedule_triggered",
    accountsNotListedEvent: "support_claims_schedule_accounts_not_listed",
  });
}
