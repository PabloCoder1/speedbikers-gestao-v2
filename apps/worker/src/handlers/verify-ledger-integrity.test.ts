import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { VerifyLedgerIntegrityDeps } from "./verify-ledger-integrity.js";
import { createVerifyLedgerIntegrityHandler } from "./verify-ledger-integrity.js";

const ORG_ID = "11111111-0000-4000-8000-000000000001";

const ENVELOPE = {
  jobType: "maintenance.verify-ledger-integrity",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
  organizationId: ORG_ID,
  dedupeKey: `verify-ledger-integrity:${ORG_ID}:2026-08-23`,
  attempt: 1,
  enqueuedAt: "2026-08-23T09:00:00.000Z",
};

function fakeDeps(options: {
  ledger?: { sku_id: string; location_kind: string; quantity: number }[];
  ledgerFails?: boolean;
  projected?: { sku_id: string; location_kind: string; quantity: number }[];
  projectedFails?: boolean;
}): { deps: VerifyLedgerIntegrityDeps; events: Record<string, unknown>[]; lines: string[] } {
  const events: Record<string, unknown>[] = [];
  const lines: string[] = [];

  const ledger = options.ledger ?? [{ sku_id: "sku-a", location_kind: "LOCAL", quantity: 42 }];
  const projected = options.projected ?? [{ sku_id: "sku-a", location_kind: "LOCAL", quantity: 42 }];

  const db = {
    rpc: (fn: string) => {
      if (fn !== "compute_inventory_balances_from_ledger") {
        throw new Error(`rpc inesperada no fake: ${fn}`);
      }

      return Promise.resolve(
        options.ledgerFails === true ? { data: null, error: { message: "boom" } } : { data: ledger, error: null },
      );
    },
    from: (table: string) => {
      if (table === "inventory_balances") {
        return {
          select: () => ({
            eq: () =>
              Promise.resolve(
                options.projectedFails === true
                  ? { data: null, error: { message: "boom" } }
                  : { data: projected, error: null },
              ),
          }),
        };
      }

      if (table === "domain_events") {
        return {
          insert: (row: Record<string, unknown>) => {
            events.push(row);

            return Promise.resolve({ error: null });
          },
          // upsert espelha insert: domain_events/stock_movements passaram a
          // gravar por ON CONFLICT DO NOTHING (D-092).
          upsert: (row: Record<string, unknown>) => {
            events.push(row);

            return Promise.resolve({ error: null });
          },
        };
      }

      throw new Error(`tabela inesperada no fake: ${table}`);
    },
  } as unknown as VerifyLedgerIntegrityDeps["db"];

  return {
    events,
    lines,
    deps: { db, now: () => new Date("2026-08-23T09:00:00.000-03:00") },
  };
}

function ctx(lines: string[], payload: unknown): { logger: ReturnType<typeof createLogger>; payload: unknown } {
  return { logger: createLogger({}, { sink: (line) => lines.push(line) }), payload };
}

describe("conferência automática ledger × projeção (D-056)", () => {
  it("ledger e projeção batendo: done com zero, nada gravado", async () => {
    const { deps, events, lines } = fakeDeps({});

    const outcome = await createVerifyLedgerIntegrityHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(events).toHaveLength(0);
  });

  it("divergência grava stock.balance.diverged crítico, organizacional (sem ml_account_id)", async () => {
    const { deps, events, lines } = fakeDeps({
      ledger: [{ sku_id: "sku-a", location_kind: "LOCAL", quantity: 50 }],
      projected: [{ sku_id: "sku-a", location_kind: "LOCAL", quantity: 42 }],
    });

    const outcome = await createVerifyLedgerIntegrityHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ml_account_id: null,
      event_type: "stock.balance.diverged",
      severity: "critico",
      source: "system",
    });
  });

  it("nunca grava em stock_movements — só detecta e alerta", async () => {
    const { deps, lines } = fakeDeps({
      ledger: [{ sku_id: "sku-a", location_kind: "LOCAL", quantity: 50 }],
      projected: [{ sku_id: "sku-a", location_kind: "LOCAL", quantity: 42 }],
    });

    // O fake não registra "stock_movements" como tabela válida — se o
    // handler tentasse escrever lá, o teste falharia com "tabela inesperada".
    await expect(
      createVerifyLedgerIntegrityHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID })),
    ).resolves.toMatchObject({ status: "done" });
  });

  it("falha ao ler o ledger é retryable", async () => {
    const { deps, lines } = fakeDeps({ ledgerFails: true });

    const outcome = await createVerifyLedgerIntegrityHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("falha ao ler a projeção é retryable", async () => {
    const { deps, lines } = fakeDeps({ projectedFails: true });

    const outcome = await createVerifyLedgerIntegrityHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("payload sem organizationId é falha definitiva", async () => {
    const { deps, lines } = fakeDeps({});

    const outcome = await createVerifyLedgerIntegrityHandler(deps)(ENVELOPE, ctx(lines, { nada: true }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });
});
