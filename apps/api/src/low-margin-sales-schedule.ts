import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho do alerta de venda abaixo da margem (D-858): um
 * `diagnostics.detect-low-margin-sales` por organização.
 *
 * **Duas vezes por dia (D-859).** O dono quer o aviso às 8h e às 17h de
 * Brasília: o job `v3-low-margin-sales` do Cloud Scheduler ("0 8,17 * * *")
 * chama `/internal/schedule/low-margin-sales`. A varredura do frete do ML roda
 * antes (6h30 e 16h30), para a rodada já julgar o pedido do ML.
 *
 * A hora cheia na chave: o Scheduler repetir a chamada na mesma hora não
 * duplica, e a rodada seguinte sempre roda.
 */

export interface LowMarginSalesScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface LowMarginSalesScheduleOutcome {
  failed?: true;
  organizationsScanned: number;
  enqueued: number;
  deduplicated: number;
}

export async function triggerLowMarginSalesDetection(deps: LowMarginSalesScheduleDeps): Promise<LowMarginSalesScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  const hourBucket = now.toISOString().slice(0, 13);

  // Só a organização com o alerta ligado: a desligada não tem o que julgar.
  const organizations = await deps.db.from("margin_alert_settings").select("organization_id").eq("enabled", true);

  if (organizations.error !== null) {
    deps.logger.error("low_margin_sales_schedule_not_listed", { reason: organizations.error.message });

    return { organizationsScanned: 0, enqueued: 0, deduplicated: 0, failed: true };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const { organization_id: organizationId } of organizations.data) {
    const result = await deps.enqueuer.enqueue({
      jobType: "diagnostics.detect-low-margin-sales",
      organizationId,
      dedupeKey: `low-margin-sales:${organizationId}:${hourBucket}`,
      queue: "maintenance",
      payload: { organizationId },
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("low_margin_sales_schedule_triggered", {
    organizations_scanned: organizations.data.length,
    enqueued,
    deduplicated,
  });

  return { organizationsScanned: organizations.data.length, enqueued, deduplicated };
}
