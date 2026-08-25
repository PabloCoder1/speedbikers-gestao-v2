import type { AdminClient } from "@sb/db";
import { toSalesMetricDate } from "@sb/domain";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho da reconciliação de Perguntas (D-089) — chamado pelo Cloud
 * Scheduler, mesmo formato de `listing-visits-schedule.ts`, por CONTA
 * (pergunta pertence a uma conta Mercado Livre específica).
 *
 * **Cadência de 6 em 6 horas, não diária.** Visita é contador cumulativo de
 * baixa urgência (D-059); pergunta não respondida é alguém esperando. Mas
 * também não é de hora em hora: o webhook continua sendo o caminho principal
 * e entrega em segundos — esta varredura só existe para o que ele perdeu, e
 * uma janela de até 6h para recuperar uma notificação perdida é folgada
 * perto do prazo humano de responder uma pergunta.
 *
 * `dedupeKey` por conta + dia + bloco de 6h: duas chamadas do Scheduler no
 * mesmo bloco colapsam, blocos diferentes sempre geram task nova. Mesmo
 * raciocínio de janela de D-051 — um ID fixo por dia seria retido pelo Cloud
 * Tasks por até 24h e descartaria as rodadas seguintes do MESMO dia.
 *
 * **O dia vem de `America/Sao_Paulo` e o bloco vem de UTC, de propósito.** O
 * dia de negócio é o mesmo de todo o resto do projeto (`toSalesMetricDate`,
 * `docs/METRICS.md`); o bloco só precisa separar as quatro rodadas diárias
 * entre si, e UTC é a base estável para isso. O cron real
 * (`20 */6 * * *` em `America/Sao_Paulo`, `infra/cloud-scheduler.sh`) dispara
 * às 00h20/06h20/12h20/18h20 de SP = 03/09/15/21 UTC, que caem em quatro
 * blocos UTC distintos — e, como SP é UTC-3, nenhuma dessas quatro horas
 * cruza a virada do dia, então a data de negócio e a data UTC coincidem em
 * todas elas. Nenhuma rodada colide com outra nem some.
 */

const BLOCK_HOURS = 6;

export interface SupportQuestionsScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface SupportQuestionsScheduleOutcome {
  accountsScanned: number;
  enqueued: number;
  deduplicated: number;
}

export async function triggerSupportQuestionsReconcile(
  deps: SupportQuestionsScheduleDeps,
): Promise<SupportQuestionsScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  const businessDate = toSalesMetricDate(now);
  const block = Math.floor(now.getUTCHours() / BLOCK_HOURS);

  const accounts = await deps.db
    .from("ml_accounts")
    .select("id, organization_id, slug")
    .eq("status", "CONNECTED");

  if (accounts.error !== null) {
    deps.logger.error("support_questions_schedule_accounts_not_listed", {
      reason: accounts.error.message,
    });

    return { accountsScanned: 0, enqueued: 0, deduplicated: 0 };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const account of accounts.data) {
    const result = await deps.enqueuer.enqueue({
      jobType: "sync.support.questions.reconcile",
      organizationId: account.organization_id,
      dedupeKey: `support-questions:${account.slug}:${businessDate}:${String(block)}`,
      queue: `ml-sync-${account.slug}`,
      payload: { mlAccountId: account.id },
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("support_questions_schedule_triggered", {
    accounts_scanned: accounts.data.length,
    enqueued,
    deduplicated,
  });

  return { accountsScanned: accounts.data.length, enqueued, deduplicated };
}
