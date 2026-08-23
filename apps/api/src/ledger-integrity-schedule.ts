import type { AdminClient } from "@sb/db";
import { toSalesMetricDate } from "@sb/domain";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho da conferência automática ledger × projeção (D-056) — chamado
 * pelo Cloud Scheduler, mesmo formato de `balance-reconcile-schedule.ts`.
 *
 * **Por ORGANIZAÇÃO, não por conta ML**: estoque é organizacional (D-006).
 *
 * Cadência DIÁRIA, mesma hora do dia que a reconciliação contra o UpSeller
 * seria redundante rodar mais vezes — a projeção só diverge do ledger por
 * bug, não por passagem do tempo (`infra/cloud-scheduler.sh` escalona os
 * dois jobs em horários diferentes para não competir por recurso).
 */

export interface LedgerIntegrityScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface LedgerIntegrityScheduleOutcome {
  organizationsScanned: number;
  enqueued: number;
  deduplicated: number;
}

export async function triggerLedgerIntegrityCheck(
  deps: LedgerIntegrityScheduleDeps,
): Promise<LedgerIntegrityScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  const businessDate = toSalesMetricDate(now);

  const organizations = await deps.db.from("organizations").select("id");

  if (organizations.error !== null) {
    deps.logger.error("ledger_integrity_schedule_organizations_not_listed", {
      reason: organizations.error.message,
    });

    return { organizationsScanned: 0, enqueued: 0, deduplicated: 0 };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const organization of organizations.data) {
    const result = await deps.enqueuer.enqueue({
      jobType: "maintenance.verify-ledger-integrity",
      organizationId: organization.id,
      dedupeKey: `verify-ledger-integrity:${organization.id}:${businessDate}`,
      queue: "maintenance",
      payload: { organizationId: organization.id },
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("ledger_integrity_schedule_triggered", {
    organizations_scanned: organizations.data.length,
    enqueued,
    deduplicated,
  });

  return { organizationsScanned: organizations.data.length, enqueued, deduplicated };
}
