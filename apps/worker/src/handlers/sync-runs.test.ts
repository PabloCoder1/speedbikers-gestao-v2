import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { AdminClient } from "@sb/db";

import { recordSyncRunFailure, recordSyncRunSuccess } from "./sync-runs.js";

const BASE = {
  organizationId: "11111111-0000-4000-8000-000000000001",
  mlAccountId: "aaaaaaaa-0000-4000-8000-000000000001",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b55",
  resource: "orders" as const,
  channel: "reconciliation" as const,
  startedAt: new Date("2026-08-24T09:00:00.000Z"),
  finishedAt: new Date("2026-08-24T09:00:05.000Z"),
};

function fakeDb(options: {
  syncRunsError?: boolean;
  syncErrorsError?: boolean;
  syncRunId?: string | null;
}): AdminClient {
  return {
    from: (table: string) => {
      if (table === "sync_runs") {
        return {
          insert: () => {
            const plainResult = { error: options.syncRunsError === true ? { message: "boom" } : null };

            return {
              // `recordSyncRunSuccess` faz `await db.from(...).insert(...)` direto
              // (sem `.select()`) — precisa ser "thenable". `recordSyncRunFailure`
              // encadeia `.select("id").maybeSingle()` — mesmo objeto suporta os dois.
              then: <T>(onFulfilled: (value: typeof plainResult) => T) =>
                Promise.resolve(plainResult).then(onFulfilled),
              select: () => ({
                maybeSingle: () =>
                  Promise.resolve(
                    options.syncRunsError === true
                      ? { data: null, error: { message: "boom" } }
                      : { data: { id: options.syncRunId ?? "run-1" }, error: null },
                  ),
              }),
            };
          },
        };
      }

      if (table === "sync_errors") {
        return {
          insert: () =>
            Promise.resolve({ error: options.syncErrorsError === true ? { message: "boom" } : null }),
        };
      }

      throw new Error(`tabela inesperada no fake: ${table}`);
    },
  } as unknown as AdminClient;
}

describe("recordSyncRunSuccess", () => {
  it("insert bem-sucedido: nada é logado", async () => {
    const lines: string[] = [];
    const logger = createLogger({}, { sink: (line) => lines.push(line) });

    await recordSyncRunSuccess(
      fakeDb({}),
      { ...BASE, itemsProcessed: 10, latestRecordAt: null },
      logger,
    );

    expect(lines.join()).not.toContain("sync_run_not_recorded");
  });

  it("falha ao gravar sync_runs: logada, não lançada — a sincronização em si já terminou", async () => {
    const lines: string[] = [];
    const logger = createLogger({}, { sink: (line) => lines.push(line) });

    await expect(
      recordSyncRunSuccess(
        fakeDb({ syncRunsError: true }),
        { ...BASE, itemsProcessed: 10, latestRecordAt: null },
        logger,
      ),
    ).resolves.toBeUndefined();

    expect(lines.join()).toContain("sync_run_not_recorded");
  });
});

describe("recordSyncRunFailure", () => {
  it("insert bem-sucedido nas duas tabelas: nada é logado", async () => {
    const lines: string[] = [];
    const logger = createLogger({}, { sink: (line) => lines.push(line) });

    await recordSyncRunFailure(fakeDb({}), { ...BASE, reason: "boom", errorClass: "retryable" }, logger);

    expect(lines.join()).not.toContain("sync_run_failure_not_recorded");
    expect(lines.join()).not.toContain("sync_error_not_recorded");
  });

  it("falha ao gravar sync_runs: logada, não lançada", async () => {
    const lines: string[] = [];
    const logger = createLogger({}, { sink: (line) => lines.push(line) });

    await expect(
      recordSyncRunFailure(
        fakeDb({ syncRunsError: true }),
        { ...BASE, reason: "boom", errorClass: "retryable" },
        logger,
      ),
    ).resolves.toBeUndefined();

    expect(lines.join()).toContain("sync_run_failure_not_recorded");
  });

  it("falha ao gravar sync_errors: logada, não lançada", async () => {
    const lines: string[] = [];
    const logger = createLogger({}, { sink: (line) => lines.push(line) });

    await expect(
      recordSyncRunFailure(
        fakeDb({ syncErrorsError: true }),
        { ...BASE, reason: "boom", errorClass: "retryable" },
        logger,
      ),
    ).resolves.toBeUndefined();

    expect(lines.join()).toContain("sync_error_not_recorded");
  });
});
