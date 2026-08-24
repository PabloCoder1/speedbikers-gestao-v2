import type { AdminClient } from "@sb/db";
import { toSalesMetricDate } from "@sb/domain";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho da medição de resultado de decisões (Fase 6, Memória de decisões
 * operacionais) — chamado pelo Cloud Scheduler, mesmo formato de
 * `sales-anomaly-actions-schedule.ts`.
 *
 * **Por ORGANIZAÇÃO**, não por conta ML — SKU é organizacional (D-006).
 *
 * Cadência DIÁRIA, depois de `detect-sales-anomalies` (`infra/cloud-scheduler.sh`
 * escalona os horários): o job usa `daily_sku_metrics` de ONTEM, já
 * completo a qualquer hora do dia seguinte — sem vantagem em rodar mais
 * cedo.
 */

export interface DecisionOutcomesScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface DecisionOutcomesScheduleOutcome {
  organizationsScanned: number;
  enqueued: number;
  deduplicated: number;
}

export async function triggerDecisionOutcomesMeasurement(
  deps: DecisionOutcomesScheduleDeps,
): Promise<DecisionOutcomesScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  const businessDate = toSalesMetricDate(now);

  const organizations = await deps.db.from("organizations").select("id");

  if (organizations.error !== null) {
    deps.logger.error("decision_outcomes_schedule_organizations_not_listed", {
      reason: organizations.error.message,
    });

    return { organizationsScanned: 0, enqueued: 0, deduplicated: 0 };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const organization of organizations.data) {
    const result = await deps.enqueuer.enqueue({
      jobType: "diagnostics.measure-decision-outcomes",
      organizationId: organization.id,
      dedupeKey: `measure-decision-outcomes:${organization.id}:${businessDate}`,
      queue: "maintenance",
      payload: { organizationId: organization.id },
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("decision_outcomes_schedule_triggered", {
    organizations_scanned: organizations.data.length,
    enqueued,
    deduplicated,
  });

  return { organizationsScanned: organizations.data.length, enqueued, deduplicated };
}
