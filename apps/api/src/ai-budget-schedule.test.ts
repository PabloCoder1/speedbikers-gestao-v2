import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { AiBudgetScheduleDeps } from "./ai-budget-schedule.js";
import { triggerAiBudgetCheck } from "./ai-budget-schedule.js";
import type { EnqueueRequest } from "./enqueue.js";

const ORGANIZATIONS = [{ id: "org-1" }, { id: "org-2" }];

function fakeDb(options: { organizationsFail?: boolean } = {}): AiBudgetScheduleDeps["db"] {
  return {
    from: () => ({
      select: () =>
        Promise.resolve(
          options.organizationsFail === true
            ? { data: null, error: { message: "boom" } }
            : { data: ORGANIZATIONS, error: null },
        ),
    }),
  } as unknown as AiBudgetScheduleDeps["db"];
}

function deps(
  options: { organizationsFail?: boolean; deduplicateOrgId?: string } = {},
): { deps: AiBudgetScheduleDeps; enqueued: EnqueueRequest[] } {
  const enqueued: EnqueueRequest[] = [];

  return {
    enqueued,
    deps: {
      db: fakeDb(options),
      logger: createLogger({}, { sink: () => undefined }),
      now: () => new Date("2026-08-27T09:00:00.000-03:00"),
      enqueuer: {
        enqueue: (request) => {
          enqueued.push(request);

          return Promise.resolve({
            taskName: "t",
            deduplicated: request.organizationId === (options.deduplicateOrgId ?? "__none__"),
            envelope: {
              jobType: request.jobType,
              jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b12",
              organizationId: request.organizationId,
              dedupeKey: request.dedupeKey,
              attempt: 1,
              enqueuedAt: "2026-08-27T12:00:00.000Z",
            },
          });
        },
      },
    },
  };
}

describe("triggerAiBudgetCheck", () => {
  it("enfileira maintenance.check-ai-budget para cada organização, uma vez cada", async () => {
    const { deps: d, enqueued } = deps();

    const outcome = await triggerAiBudgetCheck(d);

    expect(outcome).toEqual({ organizationsScanned: 2, enqueued: 2, deduplicated: 0 });
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]).toMatchObject({
      jobType: "maintenance.check-ai-budget",
      organizationId: "org-1",
      queue: "maintenance",
      dedupeKey: "check-ai-budget:org-1:2026-08-27",
      payload: { organizationId: "org-1" },
    });
  });

  it("a chave de dedupe é a data de negócio (America/Sao_Paulo) — cadência diária", async () => {
    const { deps: d, enqueued } = deps();

    await triggerAiBudgetCheck(d);

    expect(enqueued.every((e) => e.dedupeKey.endsWith(":2026-08-27"))).toBe(true);
  });

  it("contabiliza deduplicados separadamente de enfileirados", async () => {
    const { deps: d } = deps({ deduplicateOrgId: "org-2" });

    const outcome = await triggerAiBudgetCheck(d);

    expect(outcome).toEqual({ organizationsScanned: 2, enqueued: 1, deduplicated: 1 });
  });

  it("devolve zero sem lançar quando a listagem de organizações falha", async () => {
    const { deps: d, enqueued } = deps({ organizationsFail: true });

    const outcome = await triggerAiBudgetCheck(d);

    expect(outcome).toEqual({ organizationsScanned: 0, enqueued: 0, deduplicated: 0 });
    expect(enqueued).toHaveLength(0);
  });

  it("sem nenhuma organização, não enfileira nada", async () => {
    const { deps: d, enqueued } = deps();
    d.db = { from: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) } as unknown as
      AiBudgetScheduleDeps["db"];

    const outcome = await triggerAiBudgetCheck(d);

    expect(outcome).toEqual({ organizationsScanned: 0, enqueued: 0, deduplicated: 0 });
    expect(enqueued).toHaveLength(0);
  });
});
