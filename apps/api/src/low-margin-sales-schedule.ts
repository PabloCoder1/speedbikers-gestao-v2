import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

const ORGANIZATIONS_PAGE_SIZE = 1000;

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

  const organizationIds: string[] = [];
  let cursor: string | undefined;
  // Termine a leitura antes de enfileirar, inclusive quando há mais de uma página.
  for (;;) {
    const query = deps.db
      .from("margin_alert_settings")
      .select("organization_id")
      .eq("enabled", true)
      .order("organization_id");
    const page = await (cursor === undefined ? query : query.gt("organization_id", cursor))
      .limit(ORGANIZATIONS_PAGE_SIZE);
    if (page.error !== null) {
      deps.logger.error("low_margin_sales_schedule_not_listed", { reason: page.error.message });
      return { organizationsScanned: 0, enqueued: 0, deduplicated: 0, failed: true };
    }

    for (const { organization_id } of page.data) organizationIds.push(organization_id);
    if (page.data.length < ORGANIZATIONS_PAGE_SIZE) break;
    cursor = organizationIds.at(-1);
  }

  let enqueued = 0;
  let deduplicated = 0;

  let enqueueFailed = false;

  for (const organizationId of organizationIds) {
    try {
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
    } catch (error) {
      enqueueFailed = true;
      deps.logger.error("low_margin_sales_enqueue_failed", {
        organization_id: organizationId,
        reason: error instanceof Error ? error.message : "falha ao enfileirar alerta de margem",
      });
    }
  }

  const failure = enqueueFailed ? { failed: true } as const : {};

  deps.logger.info("low_margin_sales_schedule_triggered", {
    organizations_scanned: organizationIds.length,
    enqueued,
    deduplicated,
    ...failure,
  });

  return { organizationsScanned: organizationIds.length, enqueued, deduplicated, ...failure };
}
