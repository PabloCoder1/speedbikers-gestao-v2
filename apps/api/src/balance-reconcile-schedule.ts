import type { AdminClient } from "@sb/db";
import { toSalesMetricDate } from "@sb/domain";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho da reconciliação de estoque contra o UpSeller (D-029) — chamado
 * pelo Cloud Scheduler, mesmo formato de `reconcile.ts`/`fulfillment-schedule.ts`
 * (comando aqui, trabalho no worker, `docs/ARCHITECTURE.md` secao 5).
 *
 * **Por ORGANIZAÇÃO, não por conta ML** — diferente dos outros dois
 * gatilhos: estoque é organizacional (D-006), não pertence a uma conta
 * Mercado Livre específica.
 *
 * Cadência DIÁRIA, não horária: o snapshot só muda quando alguém reimporta
 * a planilha do UpSeller manualmente (esporádico), diferente de pedidos ou
 * Full, que têm uma fonte que se atualiza sozinha o tempo todo.
 */

export interface BalanceReconcileScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface BalanceReconcileScheduleOutcome {
  organizationsScanned: number;
  enqueued: number;
  deduplicated: number;
}

export async function triggerBalanceReconciliation(
  deps: BalanceReconcileScheduleDeps,
): Promise<BalanceReconcileScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  const businessDate = toSalesMetricDate(now);

  const organizations = await deps.db.from("organizations").select("id");

  if (organizations.error !== null) {
    deps.logger.error("balance_reconcile_schedule_organizations_not_listed", {
      reason: organizations.error.message,
    });

    return { organizationsScanned: 0, enqueued: 0, deduplicated: 0 };
  }

  let enqueued = 0;
  let deduplicated = 0;

  for (const organization of organizations.data) {
    const result = await deps.enqueuer.enqueue({
      jobType: "maintenance.reconcile-balances",
      organizationId: organization.id,
      dedupeKey: `reconcile-balances:${organization.id}:${businessDate}`,
      queue: "maintenance",
      payload: { organizationId: organization.id },
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("balance_reconcile_schedule_triggered", {
    organizations_scanned: organizations.data.length,
    enqueued,
    deduplicated,
  });

  return { organizationsScanned: organizations.data.length, enqueued, deduplicated };
}
