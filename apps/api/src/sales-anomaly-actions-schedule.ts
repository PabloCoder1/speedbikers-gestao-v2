import type { AdminClient } from "@sb/db";
import { toSalesMetricDate } from "@sb/domain";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho da detecção de anomalia de venda (Fase 6, D-064) — chamado pelo
 * Cloud Scheduler, mesmo formato de `ledger-integrity-schedule.ts`.
 *
 * **Por ORGANIZAÇÃO**, não por conta ML — SKU é organizacional (D-006).
 *
 * Cadência DIÁRIA, depois de `verify-ledger-integrity`/`listing-visits`
 * (`infra/cloud-scheduler.sh` escalona os horários): o diagnóstico usa
 * `daily_sku_metrics`/`domain_events` de ONTEM, que já estão completos a
 * qualquer hora do dia seguinte — não há vantagem em rodar mais cedo.
 */

export interface SalesAnomalyActionsScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface SalesAnomalyActionsScheduleOutcome {
  organizationsScanned: number;
  enqueued: number;
  deduplicated: number;
}

export async function triggerSalesAnomalyActionsDetection(
  deps: SalesAnomalyActionsScheduleDeps,
): Promise<SalesAnomalyActionsScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  const businessDate = toSalesMetricDate(now);

  const organizations = await deps.db.from("organizations").select("id");

  if (organizations.error !== null) {
    deps.logger.error("sales_anomaly_actions_schedule_organizations_not_listed", {
      reason: organizations.error.message,
    });

    return { organizationsScanned: 0, enqueued: 0, deduplicated: 0 };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const organization of organizations.data) {
    const result = await deps.enqueuer.enqueue({
      jobType: "diagnostics.detect-sales-anomalies",
      organizationId: organization.id,
      dedupeKey: `detect-sales-anomalies:${organization.id}:${businessDate}`,
      queue: "maintenance",
      payload: { organizationId: organization.id },
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("sales_anomaly_actions_schedule_triggered", {
    organizations_scanned: organizations.data.length,
    enqueued,
    deduplicated,
  });

  return { organizationsScanned: organizations.data.length, enqueued, deduplicated };
}
