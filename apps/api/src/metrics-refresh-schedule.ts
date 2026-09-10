import type { AdminClient } from "@sb/db";
import { shiftBusinessDate, toSalesMetricDate } from "@sb/domain";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * O PISO DE FRESCOR DAS MÉTRICAS (D-304) — o gatilho que faz o recálculo
 * acontecer mesmo quando ninguém vendeu nada.
 *
 * ## Por que ele precisa existir
 *
 * `analytics.recompute` sempre foi movido por CHAVE SUJA: a reconciliação
 * horária de pedidos marca as datas que mudaram e enfileira uma por data. Isso
 * é eficiente e está certo — mas amarra o frescor ao FLUXO DE VENDA. Numa hora
 * sem pedido novo, nenhuma data fica suja, nenhum recálculo roda, e o carimbo
 * de "conferido em" para de andar.
 *
 * Medido na produção em 2026-09-10: o volume atual esconde isso (as quatro
 * contas produziram recálculo em toda hora das últimas 24), mas o que sustenta
 * o selo verde é o movimento da loja, não uma garantia do sistema. O usuário
 * pediu a garantia — "faça o worker não deixar isso acontecer" —, e garantia
 * que depende de venda não é garantia.
 *
 * ## Por que HOJE e ONTEM, e não só hoje
 *
 * À meia-noite e vinte de São Paulo, "ontem" ainda recebe pedido: uma compra
 * das 23h58 chega pelo webhook depois da virada, e a data de negócio dela é a
 * de ontem. Recalcular só hoje deixaria a última hora do dia anterior
 * congelada até alguma reconciliação sujar aquela data por acaso.
 *
 * ## Por que não é um job novo
 *
 * O trabalho é o MESMO `analytics.recompute` que já existe, com o mesmo
 * handler e a mesma RPC. O que muda é quem o pede. Um segundo tipo de job com
 * o mesmo corpo seria uma segunda verdade sobre como se recalcula métrica.
 */

export interface MetricsRefreshScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface MetricsRefreshScheduleOutcome {
  accountsScanned: number;
  enqueued: number;
  deduplicated: number;
  dates: string[];
}

/**
 * A chave leva a HORA CHEIA, como as demais varreduras desta casa: chamar a
 * rota duas vezes na mesma hora não gera trabalho dobrado, e a hora seguinte
 * sempre gera. É a mesma mecânica de `fulfillment-schedule` e a lição de D-051
 * sobre id fixo por dia sendo retido pelo Cloud Tasks.
 *
 * O prefixo é `refresh:` e não `recompute:` de propósito: a reconciliação usa
 * o segundo, e as duas precisam poder pedir a MESMA data na mesma hora sem uma
 * calar a outra. Recalcular duas vezes custa uma passada que não escreve nada
 * (D-199) — barato; perder o piso porque a reconciliação chegou primeiro
 * custaria a garantia inteira.
 */
export async function triggerMetricsRefresh(
  deps: MetricsRefreshScheduleDeps,
): Promise<MetricsRefreshScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  const hourBucket = now.toISOString().slice(0, 13);

  const hoje = toSalesMetricDate(now);
  const ontem = shiftBusinessDate(hoje, -1);
  const dates = [ontem, hoje];

  const accounts = await deps.db
    .from("ml_accounts")
    .select("id, organization_id, slug")
    .eq("status", "CONNECTED");

  if (accounts.error !== null) {
    deps.logger.error("metrics_refresh_accounts_not_listed", { reason: accounts.error.message });

    return { accountsScanned: 0, enqueued: 0, deduplicated: 0, dates };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const account of accounts.data) {
    for (const metricDate of dates) {
      const result = await deps.enqueuer.enqueue({
        jobType: "analytics.recompute",
        organizationId: account.organization_id,
        dedupeKey: `refresh:${account.slug}:${metricDate}:${hourBucket}`,
        queue: "analytics-recompute",
        payload: { mode: "incremental", mlAccountId: account.id, metricDate },
      });

      if (result.deduplicated) {
        deduplicated += 1;
      } else {
        enqueued += 1;
      }
    }
  }

  deps.logger.info("metrics_refresh_scheduled", {
    accounts: accounts.data.length,
    enqueued,
    deduplicated,
    dates,
  });

  return { accountsScanned: accounts.data.length, enqueued, deduplicated, dates };
}
