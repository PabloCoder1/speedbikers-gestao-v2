import type { AdminClient } from "@sb/db";
import { computeReconciliationAdjustments, toSalesMetricDate } from "@sb/domain";
import type { ReconciliationBalance } from "@sb/domain";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import { readAllPages } from "../read-all-pages.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { recordDomainEvents } from "./domain-events.js";
import { recordStockMovements } from "./stock-movements.js";

/**
 * Reconciliação de estoque contra o snapshot do UpSeller (D-029, D-054),
 * job `maintenance.reconcile-balances`.
 *
 * Compara o saldo-alvo do UpSeller (`compute_erp_target_balances`)
 * contra o ledger atual (`inventory_balances`) e grava `AJUSTE_RECONCILIACAO`
 * + `stock.balance.diverged` (crítico) para cada SKU/location que divergir —
 * a lógica em si é `computeReconciliationAdjustments`, pura, testada sem
 * banco (`@sb/domain/inventory`).
 *
 * **Por organização, não por conta ML** — diferente de todos os outros jobs
 * agendados (`sync.orders.window`, `sync.fulfillment.snapshot`): estoque é
 * organizacional (D-006), não pertence a uma conta específica.
 *
 * **D-131 — as duas leituras vinham truncadas em 1.000 linhas e isso
 * corrompeu o saldo de produção.** Nenhuma das duas paginava, contra 6.744
 * linhas de snapshot e 2.524 de ledger. O ledger ausente é lido como ZERO
 * por `computeReconciliationAdjustments`, então o ajuste passava a ser o
 * valor inteiro do snapshot; como a chave de idempotência inclui a data, ele
 * era reinserido a cada rodada e a trigger de `inventory_balances` somava.
 * Quatro rodadas depois havia SKU com saldo exatamente 4× o real, 65% dos
 * saldos negativos e 9.225 eventos `stock.balance.diverged` — quase todos
 * denunciando uma divergência que o próprio truncamento tinha criado.
 *
 * O handler corrigido REPARA o dado sozinho: com o ledger inteiro visível, o
 * delta passa a ser `snapshot - saldo_inflado` (negativo) e traz o saldo de
 * volta ao snapshot na primeira rodada. `stock_movements` é append-only, então
 * o conserto é compensação, nunca apagamento.
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

interface SnapshotRow {
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
  //
  // PAGINADO desde D-131, e esta é a metade mais destrutiva do defeito: a
  // tabela tem 2.524 linhas e a consulta voltava com 1.000. SKU ausente do
  // Map é lido como ledger ZERO por `computeReconciliationAdjustments`, então
  // o ajuste virava o valor INTEIRO do snapshot — todo dia, acumulando pela
  // trigger. Medido: SKU com saldo 39.996 para um snapshot de 9.999.
  const rows = await readAllPages<LedgerRow>((from, to) =>
    db
      .from("inventory_balances")
      .select("sku_id, location_kind, quantity")
      .eq("organization_id", organizationId)
      .in("location_kind", ["LOCAL", "RESERVADO"])
      .order("sku_id")
      .order("location_kind")
      .range(from, to),
    { label: "falha ao consultar inventory_balances" },
  );

  return rows.map((row) => ({
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

    // PAGINADO desde D-131: a função devolve uma linha por SKU e por location
    // (LOCAL + RESERVADO). Medido em produção: 6.744 linhas para 3.372 SKUs,
    // contra o teto de 1.000 de `supabase/config.toml`. Sem paginação, 85% do
    // catálogo nunca era comparado — e nada avisava, porque `error` vem nulo.
    //
    // O `union all` da função emite TODOS os LOCAL antes do primeiro
    // RESERVADO, então o corte em 1.000 decapitava a metade RESERVADO
    // inteira, sempre. Medido: zero linhas RESERVADO em `inventory_balances`
    // e zero ajustes RESERVADO em quatro dias, contra 300 linhas de snapshot
    // com reservado diferente de zero. Como este job é a ÚNICA fonte de
    // movimento RESERVADO da V3, o item "Reservado e em trânsito" da Fase 4
    // está marcado como concluído no ROADMAP e nunca funcionou um dia.
    //
    // A fonte é `compute_erp_target_balances` desde D-132: o snapshot ROLADO
    // PARA A FRENTE pelos movimentos posteriores à captura. Com o retrato
    // cru, este job apagava a venda de cada dia enquanto ninguém reimportasse
    // a planilha.
    let snapshotBalances: ReconciliationBalance[];

    try {
      const snapshotRows = await readAllPages<SnapshotRow>((from, to) =>
        deps.db
          .rpc("compute_erp_target_balances", { p_organization_id: organizationId })
          .order("sku_id")
          .order("location_kind")
          .range(from, to),
        { label: "falha ao consultar o snapshot do UpSeller" },
      );

      snapshotBalances = snapshotRows.map((row) => ({
        skuId: row.sku_id,
        locationKind: row.location_kind as "LOCAL" | "RESERVADO",
        quantity: row.quantity,
      }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "falha ao consultar o snapshot do UpSeller";

      return { status: "failed", retryable: true, reason };
    }

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
      );

      await recordDomainEvents(
        deps.db,
        { organizationId },
        adjustments.map((a) => a.event),
        context.logger,
      );
    }

    // `snapshot_rows` e `ledger_rows` são instrumentação de D-131, não
    // enfeite: o defeito era invisível justamente porque ninguém conseguia
    // ver quantas linhas o job tinha lido. Com estes dois números no log, uma
    // leitura truncada volta a ser detectável comparando com o banco.
    context.logger.info("balances_reconciled", {
      organization_id: organizationId,
      snapshot_rows: snapshotBalances.length,
      ledger_rows: ledgerBalances.length,
      skus_compared: skuIds.length,
      adjustments: adjustments.length,
    });

    return { status: "done", processed: adjustments.length };
  };
}
