import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho da reconciliação de Perguntas (D-089) — chamado pelo Cloud
 * Scheduler, mesmo formato de `listing-visits-schedule.ts`, por CONTA
 * (pergunta pertence a uma conta Mercado Livre específica).
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
 *
 * `dedupeKey` por conta + **janela de minuto UTC**, exatamente o mecanismo de
 * D-051: duas chamadas no mesmo minuto colapsam (o caso real é um retry do
 * Scheduler), minutos diferentes sempre geram task nova.
 *
 * **A granularidade da chave PRECISA acompanhar a cadência.** Enquanto ela era
 * `{dia}:{bloco-6h}`, qualquer execução extra dentro do mesmo bloco era
 * descartada — inclusive um disparo manual, que "queimava" o bloco e fazia a
 * rodada natural seguinte sumir sem deixar rastro de falha (observado em
 * 2026-08-25, registrado em D-091). Com janela de minuto, o cron de 10 em 10
 * minutos nunca colide consigo mesmo, e um disparo manual só colidiria com
 * outro no mesmo minuto.
 */

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
  // `YYYY-MM-DDTHH:mm` — a mesma fatia usada pela chave suja do analytics.
  const minuteWindow = now.toISOString().slice(0, 16);

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
      dedupeKey: `support-questions:${account.slug}:${minuteWindow}`,
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
