import type { AdminClient } from "@sb/db";
import { toSalesMetricDate } from "@sb/domain";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho do aviso de orçamento de IA (D-100) — chamado pelo Cloud
 * Scheduler, mesmo formato de `ledger-integrity-schedule.ts` (comando aqui,
 * trabalho no worker, `docs/ARCHITECTURE.md` secao 5).
 *
 * **Por ORGANIZAÇÃO, não por conta ML** — custo de IA é organizacional
 * (`ai_runs` nem tem `ml_account_id`), mesmo raciocínio dos outros dois
 * gatilhos de manutenção.
 *
 * Cadência DIÁRIA com dedupe por dia: o custo do mês só cresce, e o EVENTO
 * é deduplicado por mês no domínio (`evaluateAiBudget`) — rodar mais de uma
 * vez por dia não avisaria duas vezes, só gastaria consulta à toa.
 */

export interface AiBudgetScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface AiBudgetScheduleOutcome {
  organizationsScanned: number;
  enqueued: number;
  deduplicated: number;
}

export async function triggerAiBudgetCheck(deps: AiBudgetScheduleDeps): Promise<AiBudgetScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  const businessDate = toSalesMetricDate(now);

  const organizations = await deps.db.from("organizations").select("id");

  if (organizations.error !== null) {
    deps.logger.error("ai_budget_schedule_organizations_not_listed", {
      reason: organizations.error.message,
    });

    return { organizationsScanned: 0, enqueued: 0, deduplicated: 0 };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const organization of organizations.data) {
    const result = await deps.enqueuer.enqueue({
      jobType: "maintenance.check-ai-budget",
      organizationId: organization.id,
      dedupeKey: `check-ai-budget:${organization.id}:${businessDate}`,
      queue: "maintenance",
      payload: { organizationId: organization.id },
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("ai_budget_schedule_triggered", {
    organizations_scanned: organizations.data.length,
    enqueued,
    deduplicated,
  });

  return { organizationsScanned: organizations.data.length, enqueued, deduplicated };
}
