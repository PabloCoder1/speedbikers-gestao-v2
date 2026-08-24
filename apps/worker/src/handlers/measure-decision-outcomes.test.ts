import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { MeasureDecisionOutcomesDeps } from "./measure-decision-outcomes.js";
import { createMeasureDecisionOutcomesHandler } from "./measure-decision-outcomes.js";

const ORG_ID = "11111111-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-24T09:00:00.000-03:00");
// `shiftBusinessDate(toSalesMetricDate(NOW), -1)`: NOW é 24/08 (Brasília) — mesmo raciocínio de `detect-sales-anomaly-actions.test.ts`.
const AS_OF = "2026-08-23";

const ENVELOPE = {
  jobType: "diagnostics.measure-decision-outcomes",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b33",
  organizationId: ORG_ID,
  dedupeKey: `measure-decision-outcomes:${ORG_ID}:${AS_OF}`,
  attempt: 1,
  enqueuedAt: "2026-08-24T09:00:00.000Z",
};

interface DecisionFixture {
  id: string;
  action_id: string;
  created_at: string;
}

const SNAPSHOT = { as_of: AS_OF, units_sold_7d: 5, avg_daily_units_7d: 0.71, avg_price_7d: 40, stock_local: 10 };

function fakeDeps(options: {
  decisions?: DecisionFixture[];
  decisionsFails?: boolean;
  outcomes?: { action_decision_id: string; window_days: number }[];
  outcomesFails?: boolean;
  actions?: { id: string; sku_id: string | null }[];
  actionsFails?: boolean;
  snapshotFails?: boolean;
  upsertFails?: boolean;
}): { deps: MeasureDecisionOutcomesDeps; upserted: Record<string, unknown>[]; lines: string[] } {
  const upserted: Record<string, unknown>[] = [];
  const lines: string[] = [];

  const decisions =
    options.decisions ??
    [{ id: "decision-1", action_id: "action-1", created_at: "2026-08-01T10:00:00.000Z" }];
  const outcomes = options.outcomes ?? [];
  const actions = options.actions ?? [{ id: "action-1", sku_id: "sku-a" }];

  const db = {
    rpc: (fn: string) => {
      if (fn !== "get_sku_decision_snapshot") {
        throw new Error(`rpc inesperada no fake: ${fn}`);
      }

      return Promise.resolve(
        options.snapshotFails === true ? { data: null, error: { message: "boom" } } : { data: SNAPSHOT, error: null },
      );
    },
    from: (table: string) => {
      if (table === "action_decisions") {
        return {
          select: () => ({
            eq: () =>
              Promise.resolve(
                options.decisionsFails === true
                  ? { data: null, error: { message: "boom" } }
                  : { data: decisions, error: null },
              ),
          }),
        };
      }

      if (table === "actions") {
        return {
          select: () => ({
            in: () =>
              Promise.resolve(
                options.actionsFails === true
                  ? { data: null, error: { message: "boom" } }
                  : { data: actions, error: null },
              ),
          }),
        };
      }

      if (table === "action_outcomes") {
        return {
          select: () => ({
            in: () =>
              Promise.resolve(
                options.outcomesFails === true
                  ? { data: null, error: { message: "boom" } }
                  : { data: outcomes, error: null },
              ),
          }),
          upsert: (rows: Record<string, unknown>[]) => {
            upserted.push(...rows);

            return Promise.resolve(
              options.upsertFails === true ? { error: { message: "boom" } } : { error: null },
            );
          },
        };
      }

      throw new Error(`tabela inesperada no fake: ${table}`);
    },
  } as unknown as MeasureDecisionOutcomesDeps["db"];

  return { upserted, lines, deps: { db, now: () => NOW } };
}

function ctx(lines: string[], payload: unknown): { logger: ReturnType<typeof createLogger>; payload: unknown } {
  return { logger: createLogger({}, { sink: (line) => lines.push(line) }), payload };
}

describe("measure-decision-outcomes", () => {
  it("decisão com 30+ dias de idade e nenhum outcome ainda: mede as três janelas", async () => {
    const { deps, upserted, lines } = fakeDeps({
      decisions: [{ id: "decision-1", action_id: "action-1", created_at: "2026-07-01T10:00:00.000Z" }],
    });

    const outcome = await createMeasureDecisionOutcomesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 3 });
    expect(upserted).toHaveLength(3);
    expect((upserted.map((r) => r.window_days) as number[]).sort((a, b) => a - b)).toEqual([7, 15, 30]);

    for (const row of upserted) {
      expect(row).toMatchObject({
        organization_id: ORG_ID,
        action_decision_id: "decision-1",
        outcome_snapshot: SNAPSHOT,
      });
    }
  });

  it("janela já medida não é remedida", async () => {
    const { deps, upserted, lines } = fakeDeps({
      decisions: [{ id: "decision-1", action_id: "action-1", created_at: "2026-07-01T10:00:00.000Z" }],
      outcomes: [
        { action_decision_id: "decision-1", window_days: 7 },
        { action_decision_id: "decision-1", window_days: 15 },
      ],
    });

    const outcome = await createMeasureDecisionOutcomesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(upserted).toHaveLength(1);
    expect(upserted[0]).toMatchObject({ window_days: 30 });
  });

  it("decisão recém-tomada: nenhuma janela pendente, não chama a RPC de snapshot", async () => {
    const { deps, upserted, lines } = fakeDeps({
      decisions: [{ id: "decision-1", action_id: "action-1", created_at: "2026-08-23T10:00:00.000Z" }],
    });

    const outcome = await createMeasureDecisionOutcomesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(upserted).toHaveLength(0);
  });

  it("ação sem sku_id: snapshot vazio, sem chamar a RPC", async () => {
    const { deps, upserted, lines } = fakeDeps({
      decisions: [{ id: "decision-1", action_id: "action-1", created_at: "2026-07-01T10:00:00.000Z" }],
      actions: [{ id: "action-1", sku_id: null }],
    });

    const outcome = await createMeasureDecisionOutcomesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 3 });

    for (const row of upserted) {
      expect(row.outcome_snapshot).toEqual({});
    }
  });

  it("organização sem decisão nenhuma: done com zero", async () => {
    const { deps, upserted, lines } = fakeDeps({ decisions: [] });

    const outcome = await createMeasureDecisionOutcomesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(upserted).toHaveLength(0);
  });

  it("falha ao ler decisões é retryable", async () => {
    const { deps, lines } = fakeDeps({ decisionsFails: true });

    const outcome = await createMeasureDecisionOutcomesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("falha ao ler outcomes já medidos é retryable", async () => {
    const { deps, lines } = fakeDeps({ outcomesFails: true });

    const outcome = await createMeasureDecisionOutcomesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("falha ao ler as actions é retryable", async () => {
    const { deps, lines } = fakeDeps({ actionsFails: true });

    const outcome = await createMeasureDecisionOutcomesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("falha na RPC de snapshot é retryable", async () => {
    const { deps, lines } = fakeDeps({
      decisions: [{ id: "decision-1", action_id: "action-1", created_at: "2026-07-01T10:00:00.000Z" }],
      snapshotFails: true,
    });

    const outcome = await createMeasureDecisionOutcomesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("falha ao gravar outcomes é retryable", async () => {
    const { deps, lines } = fakeDeps({
      decisions: [{ id: "decision-1", action_id: "action-1", created_at: "2026-07-01T10:00:00.000Z" }],
      upsertFails: true,
    });

    const outcome = await createMeasureDecisionOutcomesHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("payload sem organizationId é falha definitiva", async () => {
    const { deps, lines } = fakeDeps({});

    const outcome = await createMeasureDecisionOutcomesHandler(deps)(ENVELOPE, ctx(lines, { nada: true }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });
});
