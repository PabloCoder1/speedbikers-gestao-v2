import type { AdminClient } from "@sb/db";
import { computeReconciliationAdjustments, toSalesMetricDate } from "@sb/domain";
import type { ReconciliationBalance } from "@sb/domain";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { recordDomainEvents } from "./domain-events.js";
import { recordStockMovements } from "./stock-movements.js";

/**
 * Reconciliação de estoque contra o snapshot do UpSeller (D-029, D-054),
 * job `maintenance.reconcile-balances`.
 *
 * Compara o snapshot mais recente do UpSeller (`compute_erp_snapshot_balances`)
 * contra o ledger atual (`inventory_balances`) e grava `AJUSTE_RECONCILIACAO`
 * + `stock.balance.diverged` (crítico) para cada SKU/location que divergir —
 * a lógica em si é `computeReconciliationAdjustments`, pura, testada sem
 * banco (`@sb/domain/inventory`).
 *
 * **Por organização, não por conta ML** — diferente de todos os outros jobs
 * agendados (`sync.orders.window`, `sync.fulfillment.snapshot`): estoque é
 * organizacional (D-006), não pertence a uma conta específica.
 */

const payloadSchema = z.object({ organizationId: z.uuid() });

export interface ReconcileBalancesDeps {
  db: AdminClient;
  now?: () => Date;
}

interface LedgerRow {
  sku_id: string;
  location_kind: string;
  quantity: number;
}

async function loadLedgerBalances(
  db: AdminClient,
  organizationId: string,
): Promise<ReconciliationBalance[]> {
  // Sem `.in("sku_id", skuIds)`: com o catálogo real (milhares de SKUs,
  // D-061), essa lista estourava o limite de tamanho de URL do PostgREST e
  // derrubava o job inteiro com "Bad Request" — achado medido em produção
  // (primeira execução real do job, 2026-08-24). Trazer o ledger inteiro da
  // organização é seguro: `computeReconciliationAdjustments` só itera sobre
  // `snapshotBalances` (ver docstring), então SKU do ledger sem contrapartida
  // no snapshot nunca é visitado — a entrada extra no Map é inofensiva.
  const result = await db
    .from("inventory_balances")
    .select("sku_id, location_kind, quantity")
    .eq("organization_id", organizationId)
    .in("location_kind", ["LOCAL", "RESERVADO"]);

  if (result.error !== null) {
    throw new Error(`falha ao consultar inventory_balances: ${result.error.message}`);
  }

  return (result.data as LedgerRow[]).map((row) => ({
    skuId: row.sku_id,
    locationKind: row.location_kind as "LOCAL" | "RESERVADO",
    quantity: row.quantity,
  }));
}

export function createReconcileBalancesHandler(deps: ReconcileBalancesDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem organizationId" };
    }

    const { organizationId } = parsed.data;
    const now = deps.now?.() ?? new Date();

    const snapshotResult = await deps.db.rpc("compute_erp_snapshot_balances", {
      p_organization_id: organizationId,
    });

    if (snapshotResult.error !== null) {
      return { status: "failed", retryable: true, reason: snapshotResult.error.message };
    }

    const snapshotBalances: ReconciliationBalance[] = snapshotResult.data.map((row) => ({
      skuId: row.sku_id,
      locationKind: row.location_kind as "LOCAL" | "RESERVADO",
      quantity: row.quantity,
    }));

    if (snapshotBalances.length === 0) {
      // Organização sem nenhum snapshot do UpSeller aplicado ainda (ou sem
      // nenhum SKU resolvido nos snapshots existentes) — nada a reconciliar,
      // não é erro.
      return { status: "done", processed: 0 };
    }

    const skuIds = [...new Set(snapshotBalances.map((b) => b.skuId))];

    let ledgerBalances: ReconciliationBalance[];

    try {
      ledgerBalances = await loadLedgerBalances(deps.db, organizationId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "falha ao consultar o ledger";

      return { status: "failed", retryable: true, reason };
    }

    const businessDate = toSalesMetricDate(now);
    const adjustments = computeReconciliationAdjustments(snapshotBalances, ledgerBalances, businessDate, now);

    if (adjustments.length > 0) {
      await recordStockMovements(
        deps.db,
        { organizationId },
        adjustments.map((a) => a.movement),
        "AJUSTE_RECONCILIACAO",
        { type: "RECONCILIATION", id: businessDate },
        context.logger,
      );

      await recordDomainEvents(
        deps.db,
        { organizationId },
        adjustments.map((a) => a.event),
        context.logger,
      );
    }

    context.logger.info("balances_reconciled", {
      organization_id: organizationId,
      skus_compared: skuIds.length,
      adjustments: adjustments.length,
    });

    return { status: "done", processed: adjustments.length };
  };
}
