import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Disparo do SKU dos itens vendidos antigos (D-362, 3ª parte) —
 * `POST /internal/backfill/order-user-products`.
 *
 * Enfileira o PRIMEIRO pedaço de cada conta CONNECTED na fila `backfill`; o
 * worker encadeia o resto, um dia por vez, até o limite
 * (`handlers/backfill-order-user-products.ts`).
 *
 * **Começa 7 dias atrás, não agora.** O pedido recente ainda volta ao worker
 * quando o envio anda, e ali ganha o SKU COM a baixa de estoque; este job dá
 * o SKU sem movimento nenhum, e é para o pedido que não volta mais.
 *
 * Idempotente pela chave de deduplicação (conta + dia de início + dias).
 */

export interface OrderUserProductsBackfillDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface OrderUserProductsBackfillOptions {
  /** Quantos dias para trás a partir de agora. */
  dias: number;
  /** Uma conta só, pelo slug — para ensaiar numa conta antes das outras. */
  conta?: string;
}

export interface OrderUserProductsBackfillOutcome {
  accountsScanned: number;
  enqueued: number;
  deduplicated: number;
  ate: string;
  limite: string;
}

/** O pedido mais novo que isso ainda volta ao worker (ver o cabeçalho). */
const DIAS_DO_WORKER = 7;

export async function triggerOrderUserProductsBackfill(
  deps: OrderUserProductsBackfillDeps,
  opcoes: OrderUserProductsBackfillOptions,
): Promise<OrderUserProductsBackfillOutcome> {
  const now = deps.now?.() ?? new Date();
  const ate = new Date(now.getTime() - DIAS_DO_WORKER * 86_400_000);
  const limite = new Date(now.getTime() - opcoes.dias * 86_400_000);
  const base = { ate: ate.toISOString(), limite: limite.toISOString() };

  let query = deps.db.from("ml_accounts").select("id, organization_id, slug").eq("status", "CONNECTED");

  if (opcoes.conta !== undefined) {
    query = query.eq("slug", opcoes.conta);
  }

  const accounts = await query;

  if (accounts.error !== null) {
    deps.logger.error("order_user_products_backfill_accounts_not_listed", { reason: accounts.error.message });

    return { accountsScanned: 0, enqueued: 0, deduplicated: 0, ...base };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const account of accounts.data) {
    const result = await deps.enqueuer.enqueue({
      jobType: "backfill.order-user-products",
      organizationId: account.organization_id,
      dedupeKey: `backfill-order-user-products:${account.slug}:inicio:${base.ate.slice(0, 10)}:${String(opcoes.dias)}`,
      queue: "backfill",
      payload: { mlAccountId: account.id, ...base },
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("order_user_products_backfill_triggered", {
    accounts_scanned: accounts.data.length,
    enqueued,
    deduplicated,
    dias: opcoes.dias,
    conta: opcoes.conta ?? null,
    ...base,
  });

  return { accountsScanned: accounts.data.length, enqueued, deduplicated, ...base };
}
