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

  const cadence = RECONCILIATION_CADENCE_MIN[resource];

  if (cadence === undefined) {
    return "sem_cadencia";
  }

  if (lastSuccessAt === null) {
    return "nunca";
  }

  const ageMin = (now.getTime() - new Date(lastSuccessAt).getTime()) / 60_000;

  if (ageMin <= cadence * 2) return "ok";
  if (ageMin <= cadence * 4) return "atencao";

  return "critico";
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
