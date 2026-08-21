import type { AdminClient } from "@sb/db";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { AnalyticsRecomputeDeps } from "./analytics-recompute.js";
import { createAnalyticsRecomputeHandler } from "./analytics-recompute.js";

const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";

const ENVELOPE = {
  jobType: "analytics.recompute",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
  organizationId: ORGANIZATION_ID,
  dedupeKey: "recompute:loja-1:2026-08-21:2026-08-21T15-37Z",
  attempt: 1,
  enqueuedAt: "2026-08-21T15:37:00.000Z",
};

function chain<T>(result: T): {
  eq: () => ReturnType<typeof chain<T>>;
  maybeSingle: () => Promise<T>;
} {
  const self = {
    eq: () => self,
    maybeSingle: () => Promise.resolve(result),
  };

  return self;
}

interface FakeDbOptions {
  account?: { id: string; organization_id: string } | null;
  accountError?: { message: string } | null;
  rpcData?: number | null;
  rpcError?: { message: string } | null;
}

function fakeDb(options: FakeDbOptions = {}): {
  db: AdminClient;
  calls: { name: string; args: unknown }[];
} {
  const calls: { name: string; args: unknown }[] = [];
  const account =
    "account" in options
      ? options.account
      : { id: ML_ACCOUNT_ID, organization_id: ORGANIZATION_ID };

  const db = {
    from: () => ({
      select: () =>
        chain({ data: account ?? null, error: options.accountError ?? null }),
    }),
    rpc: (name: string, args: unknown) => {
      calls.push({ name, args });

      return Promise.resolve({
        data: "rpcData" in options ? options.rpcData : 5,
        error: options.rpcError ?? null,
      });
    },
  } as unknown as AdminClient;

  return { db, calls };
}

function run(deps: AnalyticsRecomputeDeps, payload: unknown, lines: string[] = []) {
  const handler = createAnalyticsRecomputeHandler(deps);

  return handler(ENVELOPE, {
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    payload,
  });
}

describe("analytics.recompute", () => {
  it("payload inválido falha definitivamente antes de tocar no banco", async () => {
    const { db, calls } = fakeDb();

    const outcome = await run({ db }, { mlAccountId: ML_ACCOUNT_ID });

    expect(outcome).toEqual({
      status: "failed",
      retryable: false,
      reason: "payload de recálculo inválido",
    });
    expect(calls).toHaveLength(0);
  });

  it("conta removida antes da execução termina sem trabalho", async () => {
    const { db, calls } = fakeDb({ account: null });

    const outcome = await run(
      { db },
      { mode: "incremental", mlAccountId: ML_ACCOUNT_ID, metricDate: "2026-08-21" },
    );

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(calls).toHaveLength(0);
  });

  it("falha de leitura da conta é retryable", async () => {
    const { db } = fakeDb({ accountError: { message: "timeout" } });

    const outcome = await run(
      { db },
      { mode: "incremental", mlAccountId: ML_ACCOUNT_ID, metricDate: "2026-08-21" },
    );

    expect(outcome).toEqual({ status: "failed", retryable: true, reason: "timeout" });
  });

  it("recusa conta de outra organização sem chamar a RPC", async () => {
    const { db, calls } = fakeDb({
      account: { id: ML_ACCOUNT_ID, organization_id: "22222222-0000-4000-8000-000000000002" },
    });

    const outcome = await run(
      { db },
      { mode: "incremental", mlAccountId: ML_ACCOUNT_ID, metricDate: "2026-08-21" },
    );

    expect(outcome).toEqual({
      status: "failed",
      retryable: false,
      reason: "conta não pertence à organização do job",
    });
    expect(calls).toHaveLength(0);
  });

  it("incremental chama a RPC estreita do dia", async () => {
    const { db, calls } = fakeDb({ rpcData: 5 });

    const outcome = await run(
      { db },
      { mode: "incremental", mlAccountId: ML_ACCOUNT_ID, metricDate: "2026-08-20" },
    );

    expect(outcome).toEqual({ status: "done", processed: 5 });
    expect(calls).toEqual([
      {
        name: "recompute_daily_sales_metrics",
        args: {
          p_organization_id: ORGANIZATION_ID,
          p_ml_account_id: ML_ACCOUNT_ID,
          p_metric_date: "2026-08-20",
        },
      },
    ]);
  });

  it("rebuild chama a mesma materialização para o intervalo", async () => {
    const { db, calls } = fakeDb({ rpcData: 123 });

    const outcome = await run(
      { db },
      {
        mode: "rebuild",
        mlAccountId: ML_ACCOUNT_ID,
        dateFrom: "2026-01-01",
        dateTo: "2026-08-20",
      },
    );

    expect(outcome).toEqual({ status: "done", processed: 123 });
    expect(calls[0]).toEqual({
      name: "rebuild_daily_sales_metrics",
      args: {
        p_organization_id: ORGANIZATION_ID,
        p_ml_account_id: ML_ACCOUNT_ID,
        p_date_from: "2026-01-01",
        p_date_to: "2026-08-20",
      },
    });
  });

  it("intervalo invertido é rejeitado sem retry", async () => {
    const { db, calls } = fakeDb();

    const outcome = await run(
      { db },
      {
        mode: "rebuild",
        mlAccountId: ML_ACCOUNT_ID,
        dateFrom: "2026-08-21",
        dateTo: "2026-08-20",
      },
    );

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(calls).toHaveLength(0);
  });

  it("falha operacional da RPC é retryable e não vaza payload no log", async () => {
    const { db } = fakeDb({ rpcError: { message: "connection reset" } });
    const lines: string[] = [];

    const outcome = await run(
      { db },
      { mode: "incremental", mlAccountId: ML_ACCOUNT_ID, metricDate: "2026-08-21" },
      lines,
    );

    expect(outcome).toEqual({
      status: "failed",
      retryable: true,
      reason: "connection reset",
    });
    expect(lines.join("\n")).not.toContain("dateFrom");
  });
});
