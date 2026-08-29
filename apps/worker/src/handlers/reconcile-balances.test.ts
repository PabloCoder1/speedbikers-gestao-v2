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
  /** Teto de linhas por resposta, como o `max_rows = 1000` real (D-131). */
  pageCap?: number;
}): { deps: ReconcileBalancesDeps; captured: Captured; lines: string[] } {
  const captured: Captured = { movements: [], events: [] };
  const lines: string[] = [];

  const snapshot =
    options.snapshot ?? [
      { sku_id: "sku-a", location_kind: "LOCAL", quantity: 50 },
      { sku_id: "sku-a", location_kind: "RESERVADO", quantity: 6 },
    ];

  const ledger = options.ledger ?? [{ sku_id: "sku-a", location_kind: "LOCAL", quantity: 42 }];

  // O fake pagina de verdade (D-131): `range(from, to)` devolve a FATIA, e o
  // teto do PostgREST é simulado por `pageCap`. Um fake que devolvesse a
  // lista inteira em qualquer chamada não conseguiria distinguir código que
  // pagina de código que não pagina — foi exatamente essa cegueira que
  // deixou o defeito passar.
  const pageCap = options.pageCap ?? 1000;

  const fatia = <T,>(linhas: T[], from: number, to: number): T[] =>
    linhas.slice(from, Math.min(to + 1, from + pageCap));

  const db = {
    rpc: (fn: string) => {
      if (fn !== "compute_erp_target_balances") {
        throw new Error(`rpc inesperada no fake: ${fn}`);
      }

      const builder = {
        order: () => builder,
        range: (from: number, to: number) =>
          Promise.resolve(
            options.snapshotFails === true
              ? { data: null, error: { message: "boom" } }
              : { data: fatia(snapshot, from, to), error: null },
          ),
      };

      return builder;
    },
    from: (table: string) => {
      if (table === "inventory_balances") {
        const builder = {
          order: () => builder,
          range: (from: number, to: number) =>
            Promise.resolve(
              options.ledgerFails === true
                ? { data: null, error: { message: "boom" } }
                : { data: fatia(ledger, from, to), error: null },
            ),
        };

        return { select: () => ({ eq: () => ({ in: () => builder }) }) };
      }

      if (table === "stock_movements") {
        return {
          insert: (row: Record<string, unknown>) => {
            captured.movements.push(row);

            return Promise.resolve({ error: null });
          },
          // upsert espelha insert: domain_events/stock_movements passaram a
          // gravar por ON CONFLICT DO NOTHING (D-092).
          upsert: (row: Record<string, unknown>) => {
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
          // upsert espelha insert: domain_events/stock_movements passaram a
          // gravar por ON CONFLICT DO NOTHING (D-092).
          upsert: (row: Record<string, unknown>) => {
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
  it("gera AJUSTE_RECONCILIACAO e stock.balance.adjusted para cada divergência", async () => {
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
      // `adjusted`/`informativo` desde D-135: o ajuste sai na mesma
      // execução, então o saldo já está correto quando este evento existe.
      event_type: "stock.balance.adjusted",
      severity: "informativo",
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
  // ---------------------------------------------------------------------
  // Truncamento silencioso do PostgREST (D-131)
  //
  // Estes três testes descrevem o defeito que corrompeu o saldo de estoque
  // em produção. Rodando contra o código ANTERIOR à correção, os três
  // falham; é essa a razão de existirem.
  // ---------------------------------------------------------------------

  it("ledger além do teto de página é lido INTEIRO — sem isso o ajuste vira o snapshot todo (D-131)", async () => {
    // 1.500 SKUs em que ledger e snapshot JÁ BATEM: a resposta certa é
    // "nenhum ajuste". Sem paginação, o handler enxergaria só os 1.000
    // primeiros do ledger, leria os outros 500 como ZERO, e inventaria 500
    // ajustes de +7 cada — exatamente a forma do defeito real.
    const linhas = Array.from({ length: 1500 }, (_, i) => ({
      sku_id: `sku-${String(i).padStart(4, "0")}`,
      location_kind: "LOCAL",
      quantity: 7,
    }));

    const { deps, captured, lines } = fakeDeps({ snapshot: linhas, ledger: linhas, pageCap: 1000 });

    const outcome = await createReconcileBalancesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(captured.movements).toHaveLength(0);
  });

  it("snapshot além do teto é comparado INTEIRO — sem isso 85% do catálogo nunca é reconciliado (D-131)", async () => {
    // Snapshot com 1.500 linhas contra ledger vazio: toda linha diverge.
    // Truncado, o handler geraria 1.000 ajustes e chamaria o dia de resolvido.
    const snapshot = Array.from({ length: 1500 }, (_, i) => ({
      sku_id: `sku-${String(i).padStart(4, "0")}`,
      location_kind: "LOCAL",
      quantity: 3,
    }));

    const { deps, captured, lines } = fakeDeps({ snapshot, ledger: [], pageCap: 1000 });

    const outcome = await createReconcileBalancesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 1500 });
    expect(captured.movements).toHaveLength(1500);

    const linhaLog = lines
      .map((l) => JSON.parse(l) as { message?: string })
      .find((l) => l.message === "balances_reconciled");

    expect(linhaLog).toMatchObject({ snapshot_rows: 1500, ledger_rows: 0 });
  });

  it("saldo inflado pelo próprio defeito é trazido de volta ao snapshot (D-131)", async () => {
    // O caso medido em produção: snapshot 9.999, saldo 39.996 (o ajuste
    // aplicado quatro vezes). O handler corrigido devolve -29.997 e o saldo
    // volta ao certo — o conserto é COMPENSAÇÃO, porque `stock_movements` é
    // append-only e não existe apagar.
    const { deps, captured, lines } = fakeDeps({
      snapshot: [{ sku_id: "sku-inflado", location_kind: "LOCAL", quantity: 9999 }],
      ledger: [{ sku_id: "sku-inflado", location_kind: "LOCAL", quantity: 39996 }],
    });

    const outcome = await createReconcileBalancesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(captured.movements[0]).toMatchObject({ sku_id: "sku-inflado", qty_delta: -29997 });
  });
});
