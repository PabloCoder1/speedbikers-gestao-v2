import type { AdminClient } from "@sb/db";
import { computeLedgerIntegrityDivergences, toSalesMetricDate } from "@sb/domain";
import type { LedgerBalance } from "@sb/domain";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import { readAllPages } from "../read-all-pages.js";
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

/**
 * PAGINADO desde D-131 — e aqui o defeito era pior do que em qualquer outro
 * lugar, porque este job É o vigia.
 *
 * As duas leituras vinham cortadas em 1.000 linhas contra 2.524 chaves reais.
 * `computeLedgerIntegrityDivergences` trata chave ausente de um lado como
 * zero, então cada chave que só uma das duas leituras alcançava virava uma
 * "divergência crítica". Medido: **6.324 dos 9.225 `stock.balance.diverged`
 * saíram daqui, e são 100% falsos** — a comparação direta em SQL entre a soma
 * do ledger e a projeção dá **zero divergências em 2.524 linhas**. A trigger
 * sempre esteve intacta.
 *
 * O alarme que existia para detectar corrupção de saldo passou 5 dias
 * gritando 1.100–1.370 vezes por dia sobre um defeito impossível, enquanto a
 * corrupção de verdade (D-131/D-132) passava despercebida ao lado.
 */
async function loadProjectedBalances(db: AdminClient, organizationId: string): Promise<LedgerBalance[]> {
  const rows = await readAllPages<BalanceRow>(
    (from, to) =>
      db
        .from("inventory_balances")
        .select("sku_id, location_kind, quantity")
        .eq("organization_id", organizationId)
        .order("sku_id")
        .order("location_kind")
        .range(from, to),
    { label: "falha ao consultar inventory_balances" },
  );

  return rows.map((row) => ({
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

    // Paginado desde D-131 pelo mesmo motivo da projeção logo abaixo: a soma
    // do ledger tem uma linha por (sku, location) e já passa de 2.500.
    let ledgerBalances: LedgerBalance[];

    try {
      const ledgerRows = await readAllPages<BalanceRow>(
        (from, to) =>
          deps.db
            .rpc("compute_inventory_balances_from_ledger", { p_organization_id: organizationId })
            .order("sku_id")
            .order("location_kind")
            .range(from, to),
        { label: "falha ao somar o ledger" },
      );

      ledgerBalances = ledgerRows.map((row) => ({
        skuId: row.sku_id,
        locationKind: row.location_kind as LedgerBalance["locationKind"],
        quantity: row.quantity,
      }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "falha ao somar o ledger";

      return { status: "failed", retryable: true, reason };
    }

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
