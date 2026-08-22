import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho da captura de estoque Full por conta — chamado pelo Cloud
 * Scheduler, mesmo formato de `reconcile.ts` (comando aqui, trabalho no
 * worker, `docs/ARCHITECTURE.md` secao 5).
 *
 * Cadência DELIBERADAMENTE menor que a reconciliação de pedidos (a cada 6h,
 * não a cada hora, `infra/cloud-scheduler.sh`): Full não muda tão rápido
 * quanto pedidos, e cada execução faz DOIS chamadas HTTP por item sem
 * variação da conta — mais conservador com o orçamento de rate limit não
 * documentado (D-042) do que copiar a cadência horária sem necessidade.
 */

export interface FulfillmentScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface FulfillmentScheduleOutcome {
  accountsScanned: number;
  enqueued: number;
  deduplicated: number;
}

/**
 * A cada conta CONNECTED, enfileira `sync.fulfillment.snapshot` com dedupe
 * por hora cheia (`full:{conta}:{janela}`, `docs/API.md` secao 3). Como o
 * próprio Scheduler só dispara a cada 6h, a granularidade de hora já basta
 * para nunca duplicar — chamar esta rota manualmente entre execuções
 * agendadas não gera trabalho extra dentro da mesma hora.
 */
export async function triggerFulfillmentSnapshot(deps: FulfillmentScheduleDeps): Promise<FulfillmentScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  const windowBucket = now.toISOString().slice(0, 13);

  const accounts = await deps.db
    .from("ml_accounts")
    .select("id, organization_id, slug")
    .eq("status", "CONNECTED");

  if (accounts.error !== null) {
    deps.logger.error("fulfillment_schedule_accounts_not_listed", { reason: accounts.error.message });

    return { accountsScanned: 0, enqueued: 0, deduplicated: 0 };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const account of accounts.data) {
    const result = await deps.enqueuer.enqueue({
      jobType: "sync.fulfillment.snapshot",
      organizationId: account.organization_id,
      dedupeKey: `full:${account.slug}:${windowBucket}`,
      queue: `ml-sync-${account.slug}`,
      payload: { mlAccountId: account.id },
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("fulfillment_schedule_triggered", {
    accounts_scanned: accounts.data.length,
    enqueued,
    deduplicated,
  });

  return { accountsScanned: accounts.data.length, enqueued, deduplicated };
}
