import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho da varredura da logística dos pedidos (D-352, R2) — chamado pelo
 * Cloud Scheduler, mesmo formato de `order-financials-schedule.ts`: por CONTA
 * (o envio pertence a uma conta Mercado Livre, e o rate limit também).
 *
 * **Cadência de 6 h, não diária.** A varredura tem teto por rodada (800 pedidos
 * com ida à rede) e o backlog de estreia é de 2.550 pedidos em produção: na
 * cadência diária ele levaria quatro dias, e a compensação da D-352 só pode
 * rodar com a varredura CONCLUÍDA (`docs/DEPLOYMENT.md`). Em regime permanente
 * a fila fica praticamente vazia — só o pedido cuja leitura do envio falhou em
 * `persist-order.ts` —, e a rodada termina em segundos.
 *
 * O `dedupeKey` leva a hora (`windowBucket`), como em `listings-schedule.ts`:
 * com a chave por DIA, uma segunda chamada no mesmo dia — a que o dono dispara
 * à mão para drenar o backlog mais rápido — seria descartada como duplicada.
 */

export interface OrderLogisticsScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface OrderLogisticsScheduleOutcome {
  accountsScanned: number;
  enqueued: number;
  deduplicated: number;
}

export async function triggerOrderLogisticsSweep(
  deps: OrderLogisticsScheduleDeps,
): Promise<OrderLogisticsScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  const windowBucket = now.toISOString().slice(0, 13);

  const accounts = await deps.db
    .from("ml_accounts")
    .select("id, organization_id, slug")
    .eq("status", "CONNECTED");

  if (accounts.error !== null) {
    deps.logger.error("order_logistics_schedule_accounts_not_listed", { reason: accounts.error.message });

    return { accountsScanned: 0, enqueued: 0, deduplicated: 0 };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const account of accounts.data) {
    const result = await deps.enqueuer.enqueue({
      jobType: "sync.order-logistics",
      organizationId: account.organization_id,
      dedupeKey: `order-logistics:${account.slug}:${windowBucket}`,
      queue: `ml-sync-${account.slug}`,
      payload: { mlAccountId: account.id },
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("order_logistics_schedule_triggered", {
    accounts_scanned: accounts.data.length,
    enqueued,
    deduplicated,
  });

  return { accountsScanned: accounts.data.length, enqueued, deduplicated };
}
