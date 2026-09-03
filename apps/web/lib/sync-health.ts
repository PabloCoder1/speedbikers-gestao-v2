/**
 * Regras puras da Saúde da Sincronização (D-143) — cadência esperada por
 * recurso e o veredito de frescor que ela habilita.
 *
 * **Por que a fórmula canônica não bastou**: `classifySyncFreshness`
 * (`@sb/domain`) tem limiares fixos calibrados para pedidos (reconciliação
 * horária). Aplicá-los a `visits` — cadência DIÁRIA — carimbaria "atrasada"
 * uma sincronização funcionando perfeitamente, todos os dias. O veredito
 * honesto depende da cadência do job, e cadência é dado de infraestrutura.
 *
 * A fonte das cadências é `infra/cloud-scheduler.sh` (os crons reais dos
 * jobs). Se um cron mudar lá e ninguém tocar aqui, o pior caso é um veredito
 * conservador demais — nunca dado inventado; o mapa aponta a fonte para a
 * revisão ser um diff de uma linha.
 */

export type SyncVerdict = "ok" | "atencao" | "critico" | "nunca" | "sem_cadencia";

/**
 * Minutos entre execuções esperadas de cada recurso no canal de
 * RECONCILIAÇÃO. Backfill fica de fora de propósito: é processo finito —
 * "não rodou nas últimas 24h" é o estado NORMAL de um backfill concluído,
 * e carimbá-lo com frescor seria a tela gritando sobre o comportamento certo.
 */
export const RECONCILIATION_CADENCE_MIN: Readonly<Record<string, number>> = {
  orders: 60, // v3-reconcile-orders: "0 * * * *"
  claims: 60, // v3-support-claims-reconcile: "15 * * * *"
  questions: 10, // v3-support-questions-reconcile: "*/10 * * * *"
  messages: 10, // v3-support-messages-reconcile: "*/10 * * * *"
  listings: 360, // v3-listings-snapshot: "0 */6 * * *"
  fulfillment: 360, // v3-fulfillment-snapshot: "0 */6 * * *"
  visits: 1440, // v3-listing-visits-snapshot: "0 7 * * *" (diário)
};

/**
 * Minutos entre execuções esperadas de cada JOB agendado, para a Saúde do
 * Sistema (D-219).
 *
 * Mesma fonte e mesma regra do mapa acima — `infra/cloud-scheduler.sh` —, mas
 * com outra chave: lá a unidade é o RECURSO por conta, aqui é o `job_type`
 * que aparece em `job_runs`. Conferido contra o Cloud Scheduler real, não só
 * contra o script.
 *
 * **Só entra job com cadência FIXA.** `analytics.recompute` (chave suja),
 * `sync.webhook.received`, `sync.support.questions`/`.messages` (webhook),
 * `backfill.orders` (finito) e os de import/relist (sob demanda) ficam de
 * fora de propósito: carimbar frescor num job orientado a evento seria gritar
 * sobre o comportamento certo — a mesma decisão que D-143 tomou para backfill.
 */
export const JOB_CADENCE_MIN: Readonly<Record<string, number>> = {
  "system.ping": 60, // v3-heartbeat: "0 * * * *"
  "sync.orders.window": 60, // v3-reconcile-orders: "0 * * * *"
  "sync.support.claims.reconcile": 60, // v3-support-claims-reconcile: "15 * * * *"
  "sync.support.questions.reconcile": 10, // v3-support-questions-reconcile: "*/10 * * * *"
  "sync.support.messages.reconcile": 10, // v3-support-messages-reconcile: "*/10 * * * *"
  "sync.listings.snapshot": 360, // v3-listings-snapshot: "0 */6 * * *"
  "sync.fulfillment.snapshot": 360, // v3-fulfillment-snapshot: "0 */6 * * *"
  "sync.listing-visits.snapshot": 1440, // v3-listing-visits-snapshot: "0 7 * * *"
  "sync.order-financials": 1440, // v3-order-financials-sweep: "30 9 * * *"
  "maintenance.reconcile-balances": 1440, // v3-reconcile-balances: "0 6 * * *"
  "maintenance.verify-ledger-integrity": 1440, // v3-verify-ledger-integrity: "30 6 * * *"
  "maintenance.check-ai-budget": 1440, // v3-check-ai-budget: "0 9 * * *"
  // Um scheduler só (v3-detect-sales-anomalies, "0 8 * * *") enfileira os dois.
  "diagnostics.detect-sales-anomalies": 1440,
  "diagnostics.detect-support-patterns": 1440,
  "diagnostics.measure-decision-outcomes": 1440, // v3-measure-decision-outcomes: "30 8 * * *"
};

/**
 * O núcleo do veredito, compartilhado pelas duas telas: até 2 ciclos perdidos
 * é tolerância normal (um 429, um deploy no horário), até 4 é atenção, acima
 * é crítico.
 */
function verdictFromCadence(cadenceMin: number | undefined, lastAt: string | null, now: Date): SyncVerdict {
  if (cadenceMin === undefined) {
    return "sem_cadencia";
  }

  if (lastAt === null) {
    return "nunca";
  }

  const ageMin = (now.getTime() - new Date(lastAt).getTime()) / 60_000;

  if (ageMin <= cadenceMin * 2) return "ok";
  if (ageMin <= cadenceMin * 4) return "atencao";

  return "critico";
}

/**
 * Veredito de frescor de um JOB AGENDADO (D-219).
 *
 * O incidente de D-217 é o motivo: `/saude` usava `JOB_STALE_HOURS = 26` para
 * todos os jobs, e `sync.orders.window` — HORÁRIO — ficou 13 horas mudo sem
 * a tela dizer nada. Treze horas é catástrofe para um job de hora em hora e
 * passa folgado sob 26. Com a cadência, o mesmo silêncio vira `critico` em
 * pouco mais de quatro horas.
 */
export function classifyJobFreshness(jobType: string, lastRunAt: string | null, now: Date): SyncVerdict {
  return verdictFromCadence(JOB_CADENCE_MIN[jobType], lastRunAt, now);
}

/**
 * O veredito compara a idade do último SUCESSO com a cadência esperada:
 * até 2 ciclos perdidos é tolerância normal (um 429, um deploy no horário),
 * até 4 é atenção, acima é crítico. Recurso sem cadência mapeada não ganha
 * veredito — datas cruas na tela valem mais que um selo chutado.
 */
export function classifyResourceFreshness(
  resource: string,
  channel: string,
  lastSuccessAt: string | null,
  now: Date,
): SyncVerdict {
  if (channel !== "reconciliation") {
    return "sem_cadencia";
  }

  return verdictFromCadence(RECONCILIATION_CADENCE_MIN[resource], lastSuccessAt, now);
}

/**
 * A taxa de falha de 24h vira alerta próprio, independente do frescor: o
 * caso real que motivou (medido em 2026-08-30) é `visits` com 85% de falha
 * POR 429 e ainda assim um sucesso diário — o frescor fica "ok" enquanto a
 * cobertura degrada. Falha alta com sucesso recente é um estado que merece
 * nome, não uma média que esconde.
 */
export function failureRateLabel(runs24h: number, failed24h: number): string | null {
  if (runs24h === 0 || failed24h === 0) {
    return null;
  }

  const pct = Math.round((failed24h / runs24h) * 100);

  return `${String(failed24h)} de ${String(runs24h)} execuções falharam (${String(pct)}%)`;
}
