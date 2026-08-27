import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Motor comum dos gatilhos de reconciliação POR CONTA chamados pelo Cloud
 * Scheduler. Perguntas (D-089) e Mensagens pós-venda usam exatamente a mesma
 * mecânica; só mudam o `jobType`, o prefixo da chave e o nome do evento.
 *
 * `dedupeKey` por conta + **janela de minuto UTC**, o mecanismo de D-051: duas
 * chamadas no mesmo minuto colapsam (o caso real é um retry do Scheduler),
 * minutos diferentes sempre geram task nova.
 *
 * **A granularidade da chave PRECISA acompanhar a cadência.** Enquanto a de
 * Perguntas era `{dia}:{bloco-6h}`, qualquer execução extra dentro do bloco
 * era descartada — inclusive um disparo manual, que "queimava" o bloco e fazia
 * a rodada natural seguinte sumir sem deixar rastro de falha (observado em
 * 2026-08-25, registrado em D-091).
 */

export interface AccountReconcileScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface AccountReconcileScheduleOutcome {
  accountsScanned: number;
  enqueued: number;
  deduplicated: number;
}

export interface AccountReconcileScheduleSpec {
  jobType: string;
  /** Prefixo da `dedupeKey`, antes de `:{slug}:{janela-de-minuto}`. */
  dedupePrefix: string;
  /** Evento de log de sucesso e o de falha ao listar contas. */
  triggeredEvent: string;
  accountsNotListedEvent: string;
}

export async function triggerAccountReconcile(
  deps: AccountReconcileScheduleDeps,
  spec: AccountReconcileScheduleSpec,
): Promise<AccountReconcileScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  // `YYYY-MM-DDTHH:mm` — a mesma fatia usada pela chave suja do analytics.
  const minuteWindow = now.toISOString().slice(0, 16);

  const accounts = await deps.db
    .from("ml_accounts")
    .select("id, organization_id, slug")
    .eq("status", "CONNECTED");

  if (accounts.error !== null) {
    deps.logger.error(spec.accountsNotListedEvent, { reason: accounts.error.message });

    return { accountsScanned: 0, enqueued: 0, deduplicated: 0 };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const account of accounts.data) {
    const result = await deps.enqueuer.enqueue({
      jobType: spec.jobType,
      organizationId: account.organization_id,
      dedupeKey: `${spec.dedupePrefix}:${account.slug}:${minuteWindow}`,
      queue: `ml-sync-${account.slug}`,
      payload: { mlAccountId: account.id },
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info(spec.triggeredEvent, {
    accounts_scanned: accounts.data.length,
    enqueued,
    deduplicated,
  });

  return { accountsScanned: accounts.data.length, enqueued, deduplicated };
}
