import type { AdminClient } from "@sb/db";
import { computeLedgerIntegrityDivergences, toSalesMetricDate } from "@sb/domain";
import type { LedgerBalance } from "@sb/domain";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { recordDomainEvents } from "./domain-events.js";

/**
 * Conferência automática ledger × projeção (D-056, `docs/ROADMAP.md`
 * Fase 4), job `maintenance.verify-ledger-integrity`.
 *
 * Compara `stock_movements` recomputado do zero
 * (`compute_inventory_balances_from_ledger`) contra a projeção mantida por
 * trigger (`inventory_balances`) e grava `stock.balance.diverged` (crítico)
 * para cada SKU/location que divergir — nunca escreve `stock_movements`
 * (ver `packages/domain/src/inventory/ledger-integrity.ts`: divergência aqui
 * é bug, não drift de processo, não há o que "corrigir" gravando mais uma
 * linha no ledger).
 *
 * **Por organização, não por conta ML** — mesmo raciocínio de
 * `maintenance.reconcile-balances`: estoque é organizacional (D-006).
 */

const payloadSchema = z.object({ organizationId: z.uuid() });

export interface VerifyLedgerIntegrityDeps {
  db: AdminClient;
  now?: () => Date;
}

interface BalanceRow {
  sku_id: string;
  location_kind: string;
  quantity: number;
}

async function loadProjectedBalances(db: AdminClient, organizationId: string): Promise<LedgerBalance[]> {
  const result = await db
    .from("inventory_balances")
    .select("sku_id, location_kind, quantity")
    .eq("organization_id", organizationId);

  if (result.error !== null) {
    throw new Error(`falha ao consultar inventory_balances: ${result.error.message}`);
  }

  return (result.data as BalanceRow[]).map((row) => ({
    skuId: row.sku_id,
    locationKind: row.location_kind as LedgerBalance["locationKind"],
    quantity: row.quantity,
  }));
}

export function createVerifyLedgerIntegrityHandler(deps: VerifyLedgerIntegrityDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem organizationId" };
    }

    const { organizationId } = parsed.data;
    const now = deps.now?.() ?? new Date();

    const ledgerResult = await deps.db.rpc("compute_inventory_balances_from_ledger", {
      p_organization_id: organizationId,
    });

    if (ledgerResult.error !== null) {
      return { status: "failed", retryable: true, reason: ledgerResult.error.message };
    }

    const ledgerBalances: LedgerBalance[] = ledgerResult.data.map((row) => ({
      skuId: row.sku_id,
      locationKind: row.location_kind as LedgerBalance["locationKind"],
      quantity: row.quantity,
    }));

    let projectedBalances: LedgerBalance[];

    try {
      projectedBalances = await loadProjectedBalances(deps.db, organizationId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "falha ao consultar a projeção";

      return { status: "failed", retryable: true, reason };
    }

    const businessDate = toSalesMetricDate(now);
    const divergences = computeLedgerIntegrityDivergences(ledgerBalances, projectedBalances, businessDate, now);

    if (divergences.length > 0) {
      await recordDomainEvents(deps.db, { organizationId }, divergences, context.logger);
    }

    context.logger.info("ledger_integrity_verified", {
      organization_id: organizationId,
      rows_compared: new Set([...ledgerBalances, ...projectedBalances].map((b) => `${b.skuId}:${b.locationKind}`)).size,
      divergences: divergences.length,
    });

    return { status: "done", processed: divergences.length };
  };
}
