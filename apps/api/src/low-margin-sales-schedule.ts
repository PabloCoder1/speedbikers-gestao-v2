import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho do alerta de venda abaixo da margem (D-858): um
 * `diagnostics.detect-low-margin-sales` por organização, de HORA EM HORA.
 *
 * **Sem job novo no Cloud Scheduler.** A rota do piso de métricas
 * (`/internal/schedule/metrics-refresh`, "35 * * * *") já é chamada toda hora;
 * ela passa a chamar também esta função, que tem módulo e teste próprios —
 * o piso continua pedindo só `analytics.recompute` (D-304). Um agendador novo
 * seria um ato do dono na infraestrutura para o mesmo minuto do relógio.
 *
 * A hora cheia na chave, como as varreduras horárias desta casa: chamar duas
 * vezes na mesma hora não duplica, e a hora seguinte sempre roda.
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
