import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho da reconciliação por janela — chamado pelo Cloud Scheduler
 * (`docs/ARCHITECTURE.md` secao 10, `docs/MERCADO_LIVRE.md` secao 3: rede de
 * segurança do que o webhook perdeu, não o caminho principal de frescor).
 *
 * A `api` só decide QUAIS contas reconciliar e enfileira; o cálculo da janela
 * (`from`/`to`, checkpoint por `sync_runs.latest_record_at`) é do worker, em
 * `sync.orders.window` — mesma fronteira de sempre: comando aqui, trabalho lá
 * (docs/ARCHITECTURE.md secao 5).
 */

export interface ReconcileDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface ReconcileOutcome {
  accountsScanned: number;
  enqueued: number;
  deduplicated: number;
}

/**
 * A cada conta CONNECTED, enfileira `sync.orders.window` com dedupe por hora
 * cheia (`sync-orders:{conta}:{janela}`, formato já registrado em
 * `docs/API.md` secao 3). Rodar o Scheduler mais de uma vez por hora não
 * gera mais chamadas ao Mercado Livre — o Cloud Tasks recusa o nome
 * repetido — porque reconciliação é rede de segurança, não caminho de
 * frescor: não há motivo para gastar orçamento de rate limit (D-042) mais
 * que uma vez por hora por conta.
 */
export async function triggerOrdersReconciliation(deps: ReconcileDeps): Promise<ReconcileOutcome> {
  const now = deps.now?.() ?? new Date();
  // "2026-08-21T15" — a hora cheia em curso. `slice(0, 13)` de um ISO com
  // milissegundos e "Z" para antes dos minutos.
  const windowBucket = now.toISOString().slice(0, 13);

  const accounts = await deps.db
    .from("ml_accounts")
    .select("id, organization_id, slug")
    .eq("status", "CONNECTED");

  if (accounts.error !== null) {
    deps.logger.error("reconcile_accounts_not_listed", { reason: accounts.error.message });

    return { accountsScanned: 0, enqueued: 0, deduplicated: 0 };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const account of accounts.data) {
    const result = await deps.enqueuer.enqueue({
      jobType: "sync.orders.window",
      organizationId: account.organization_id,
      dedupeKey: `sync-orders:${account.slug}:${windowBucket}`,
      queue: `ml-sync-${account.slug}`,
      payload: { mlAccountId: account.id },
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("reconcile_triggered", {
    accounts_scanned: accounts.data.length,
    enqueued,
    deduplicated,
  });

  return { accountsScanned: accounts.data.length, enqueued, deduplicated };
}
