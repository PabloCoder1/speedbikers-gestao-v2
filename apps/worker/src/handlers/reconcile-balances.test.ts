import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { ReconcileBalancesDeps } from "./reconcile-balances.js";
import { createReconcileBalancesHandler } from "./reconcile-balances.js";

const ORG_ID = "11111111-0000-4000-8000-000000000001";

const ENVELOPE = {
  jobType: "maintenance.reconcile-balances",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
  organizationId: ORG_ID,
  dedupeKey: `reconcile-balances:${ORG_ID}:2026-08-23`,
  attempt: 1,
  enqueuedAt: "2026-08-23T09:00:00.000Z",
};

interface Captured {
  movements: Record<string, unknown>[];
  events: Record<string, unknown>[];
}

function fakeDeps(options: {
  snapshot?: { sku_id: string; location_kind: string; quantity: number }[];
  snapshotFails?: boolean;
  ledger?: { sku_id: string; location_kind: string; quantity: number }[];
  ledgerFails?: boolean;
}): { deps: ReconcileBalancesDeps; captured: Captured; lines: string[] } {
  const captured: Captured = { movements: [], events: [] };
  const lines: string[] = [];

  const snapshot =
    options.snapshot ?? [
      { sku_id: "sku-a", location_kind: "LOCAL", quantity: 50 },
      { sku_id: "sku-a", location_kind: "RESERVADO", quantity: 6 },
    ];

  const ledger = options.ledger ?? [{ sku_id: "sku-a", location_kind: "LOCAL", quantity: 42 }];

  const db = {
    rpc: (fn: string) => {
      if (fn !== "compute_erp_snapshot_balances") {
        throw new Error(`rpc inesperada no fake: ${fn}`);
      }

      return Promise.resolve(
        options.snapshotFails === true ? { data: null, error: { message: "boom" } } : { data: snapshot, error: null },
      );
    },
    from: (table: string) => {
      if (table === "inventory_balances") {
        return {
          select: () => ({
            eq: () => ({
              in: () =>
                Promise.resolve(
                  options.ledgerFails === true
                    ? { data: null, error: { message: "boom" } }
                    : { data: ledger, error: null },
                ),
            }),
          }),
        };
      }

      if (table === "stock_movements") {
        return {
          insert: (row: Record<string, unknown>) => {
            captured.movements.push(row);

            return Promise.resolve({ error: null });
          },
        };
      }

      if (table === "domain_events") {
        return {
          insert: (row: Record<string, unknown>) => {
            captured.events.push(row);

            return Promise.resolve({ error: null });
          },
        };
      }

      throw new Error(`tabela inesperada no fake: ${table}`);
    },
  } as unknown as ReconcileBalancesDeps["db"];

  return {
    captured,
    lines,
    deps: { db, now: () => new Date("2026-08-23T09:00:00.000-03:00") },
  };
}

function ctx(lines: string[], payload: unknown): { logger: ReturnType<typeof createLogger>; payload: unknown } {
  return { logger: createLogger({}, { sink: (line) => lines.push(line) }), payload };
}

describe("reconciliação de estoque contra o UpSeller", () => {
  it("gera AJUSTE_RECONCILIACAO e stock.balance.diverged para cada divergência", async () => {
    const { deps, captured, lines } = fakeDeps({});

    const outcome = await createReconcileBalancesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 2 });
    expect(captured.movements).toHaveLength(2);
    expect(captured.events).toHaveLength(2);

    const local = captured.movements.find((m) => m.location_kind === "LOCAL");
    expect(local).toMatchObject({
      sku_id: "sku-a",
      qty_delta: 8,
      movement_type: "AJUSTE_RECONCILIACAO",
      source_type: "RECONCILIATION",
    });

    // RESERVADO não tinha linha nenhuma no ledger — nasce do zero (D-054).
    const reservado = captured.movements.find((m) => m.location_kind === "RESERVADO");
    expect(reservado).toMatchObject({ sku_id: "sku-a", qty_delta: 6 });
  });

  it("evento gravado sem ml_account_id — é organizacional (D-054)", async () => {
    const { deps, captured, lines } = fakeDeps({});

    await createReconcileBalancesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(captured.events[0]).toMatchObject({
      ml_account_id: null,
      event_type: "stock.balance.diverged",
      severity: "critico",
      source: "system",
    });
  });

  it("sem divergência nenhuma, não grava nada", async () => {
    const { deps, captured, lines } = fakeDeps({
      snapshot: [{ sku_id: "sku-a", location_kind: "LOCAL", quantity: 42 }],
      ledger: [{ sku_id: "sku-a", location_kind: "LOCAL", quantity: 42 }],
    });

    const outcome = await createReconcileBalancesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(captured.movements).toHaveLength(0);
    expect(captured.events).toHaveLength(0);
  });

  it("ledger sem filtro por SKU: linha extra sem contrapartida no snapshot é ignorada, não vira ajuste", async () => {
    // Achado em produção (2026-08-24): a query do ledger deixou de filtrar por
    // sku_id (URL longa demais com o catálogo real, `Bad Request` do
    // PostgREST) — o ledger inteiro da organização volta, e SKU sem linha no
    // snapshot precisa continuar não gerando ajuste (docstring de
    // computeReconciliationAdjustments).
    const { deps, captured, lines } = fakeDeps({
      snapshot: [{ sku_id: "sku-a", location_kind: "LOCAL", quantity: 42 }],
      ledger: [
        { sku_id: "sku-a", location_kind: "LOCAL", quantity: 42 },
        { sku_id: "sku-fora-do-snapshot", location_kind: "LOCAL", quantity: 999 },
      ],
    });

    const outcome = await createReconcileBalancesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(captured.movements).toHaveLength(0);
  });

  it("organização sem nenhum snapshot do UpSeller: done com zero, não é erro", async () => {
    const { deps, captured, lines } = fakeDeps({ snapshot: [] });

    const outcome = await createReconcileBalancesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(captured.movements).toHaveLength(0);
  });

  it("falha ao ler o snapshot é retryable", async () => {
    const { deps, lines } = fakeDeps({ snapshotFails: true });

    const outcome = await createReconcileBalancesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("falha ao ler o ledger é retryable", async () => {
    const { deps, lines } = fakeDeps({ ledgerFails: true });

    const outcome = await createReconcileBalancesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("payload sem organizationId é falha definitiva", async () => {
    const { deps, lines } = fakeDeps({});

    const outcome = await createReconcileBalancesHandler(deps)(ENVELOPE, ctx(lines, { nada: true }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });
});
