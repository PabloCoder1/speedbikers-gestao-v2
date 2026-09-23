import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Disparo da recuperação de frete (D-396) — `POST /internal/backfill/order-financials`.
 *
 * Enfileira o PRIMEIRO pedaço de cada conta CONNECTED na fila `backfill`; o
 * worker encadeia o resto, um dia por vez, até o limite
 * (`handlers/backfill-order-financials.ts`). O pedaço começa onde a varredura
 * diária termina — os últimos 7 dias já são dela — e desce `dias` para trás.
 *
 * Idempotente pela chave de deduplicação (conta + dia de início): disparar de
 * novo no mesmo dia não duplica a corrente, e um disparo em outro dia recomeça
 * pulando tudo o que já foi gravado.
 */

export interface OrderFinancialsBackfillDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface OrderFinancialsBackfillOptions {
  /** Quantos dias para trás a partir de agora. */
  dias: number;
  /** Uma conta só, pelo slug — para ensaiar numa conta antes das outras. */
  conta?: string;
}

export interface OrderFinancialsBackfillOutcome {
  accountsScanned: number;
  enqueued: number;
  deduplicated: number;
  ate: string;
  limite: string;
}

/** Os mesmos 7 dias de `SWEEP_WINDOW_DAYS` da varredura diária: a recuperação começa onde ela termina. */
const JANELA_DA_VARREDURA_DIAS = 7;

export const DIAS_MAXIMOS = 365;

export async function triggerOrderFinancialsBackfill(
  deps: OrderFinancialsBackfillDeps,
  opcoes: OrderFinancialsBackfillOptions,
): Promise<OrderFinancialsBackfillOutcome> {
  const now = deps.now?.() ?? new Date();
  const ate = new Date(now.getTime() - JANELA_DA_VARREDURA_DIAS * 86_400_000);
  const limite = new Date(now.getTime() - opcoes.dias * 86_400_000);
  const base = { ate: ate.toISOString(), limite: limite.toISOString() };

  let query = deps.db.from("ml_accounts").select("id, organization_id, slug").eq("status", "CONNECTED");

  if (opcoes.conta !== undefined) {
    query = query.eq("slug", opcoes.conta);
  }

  const accounts = await query;

  if (accounts.error !== null) {
    deps.logger.error("order_financials_backfill_accounts_not_listed", { reason: accounts.error.message });

    return { accountsScanned: 0, enqueued: 0, deduplicated: 0, ...base };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const account of accounts.data) {
    const result = await deps.enqueuer.enqueue({
      jobType: "backfill.order-financials",
      organizationId: account.organization_id,
      dedupeKey: `backfill-order-financials:${account.slug}:inicio:${base.ate.slice(0, 10)}:${String(opcoes.dias)}`,
      queue: "backfill",
      payload: { mlAccountId: account.id, ...base },
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("order_financials_backfill_triggered", {
    accounts_scanned: accounts.data.length,
    enqueued,
    deduplicated,
    dias: opcoes.dias,
    conta: opcoes.conta ?? null,
    ...base,
  });

  return { accountsScanned: accounts.data.length, enqueued, deduplicated, ...base };
}
