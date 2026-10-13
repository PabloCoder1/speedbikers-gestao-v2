import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";
import type { ShopeeEnvironment } from "@sb/shopee";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho da sincronização de pedidos da Shopee (D-426) — chamado pelo Cloud
 * Scheduler, uma vez por hora, no formato de `listings-schedule.ts`: uma
 * tarefa `shopee.orders.sync` por loja CONECTADA do ambiente configurado, na
 * fila `backfill`. A janela de cada execução sai do marco da loja; o gatilho
 * só garante que toda loja é visitada a cada hora.
 */

export interface ShopeeOrdersScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  environment: ShopeeEnvironment;
  now?: () => Date;
}

export interface ShopeeOrdersScheduleOutcome {
  failed?: true;
  shopsScanned: number;
  enqueued: number;
  deduplicated: number;
}

export async function triggerShopeeOrdersSync(deps: ShopeeOrdersScheduleDeps): Promise<ShopeeOrdersScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  const hora = now.toISOString().slice(0, 13);

  const lojas = await deps.db
    .from("shopee_shops")
    .select("id, organization_id")
    .eq("status", "CONNECTED")
    .eq("environment", deps.environment);

  if (lojas.error !== null) {
    deps.logger.error("shopee_orders_schedule_shops_not_listed", { reason: lojas.error.message });

    return { shopsScanned: 0, enqueued: 0, deduplicated: 0, failed: true };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const loja of lojas.data) {
    const result = await deps.enqueuer.enqueue({
      jobType: "shopee.orders.sync",
      organizationId: loja.organization_id,
      dedupeKey: `shopee-orders:${loja.id}:hora:${hora}`,
      queue: "backfill",
      payload: { shopeeShopId: loja.id },
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("shopee_orders_schedule_triggered", { shops_scanned: lojas.data.length, enqueued, deduplicated });

  return { shopsScanned: lojas.data.length, enqueued, deduplicated };
}
