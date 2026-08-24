import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { DecisionOutcomesScheduleDeps } from "./decision-outcomes-schedule.js";
import { triggerDecisionOutcomesMeasurement } from "./decision-outcomes-schedule.js";
import type { EnqueueRequest } from "./enqueue.js";

const ORGANIZATIONS = [{ id: "org-1" }, { id: "org-2" }];

function fakeDb(options: { organizationsFail?: boolean } = {}): DecisionOutcomesScheduleDeps["db"] {
  return {
    from: () => ({
      select: () =>
        Promise.resolve(
          options.organizationsFail === true
            ? { data: null, error: { message: "boom" } }
            : { data: ORGANIZATIONS, error: null },
        ),
    }),
  } as unknown as DecisionOutcomesScheduleDeps["db"];
}

function deps(
  options: { organizationsFail?: boolean; deduplicateOrgId?: string } = {},
): { deps: DecisionOutcomesScheduleDeps; enqueued: EnqueueRequest[] } {
  const enqueued: EnqueueRequest[] = [];

  return {
    enqueued,
    deps: {
      db: fakeDb(options),
      logger: createLogger({}, { sink: () => undefined }),
      now: () => new Date("2026-08-23T09:15:00.000-03:00"),
      enqueuer: {
        enqueue: (request) => {
          enqueued.push(request);

          return Promise.resolve({
            taskName: "t",
            deduplicated: request.organizationId === (options.deduplicateOrgId ?? "__none__"),
            envelope: {
              jobType: request.jobType,
              jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b44",
              organizationId: request.organizationId,
              dedupeKey: request.dedupeKey,
              attempt: 1,
              enqueuedAt: "2026-08-23T12:15:00.000Z",
            },
          });
        },
      },
    },
  };
}

describe("triggerDecisionOutcomesMeasurement", () => {
  it("enfileira diagnostics.measure-decision-outcomes para cada organização, uma vez cada", async () => {
    const { deps: d, enqueued } = deps();

    const outcome = await triggerDecisionOutcomesMeasurement(d);

    expect(outcome).toEqual({ organizationsScanned: 2, enqueued: 2, deduplicated: 0 });
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]).toMatchObject({
      jobType: "diagnostics.measure-decision-outcomes",
      organizationId: "org-1",
      queue: "maintenance",
      dedupeKey: "measure-decision-outcomes:org-1:2026-08-23",
      payload: { organizationId: "org-1" },
    });
  });

  it("a chave de dedupe é a data de negócio (America/Sao_Paulo), não a hora — cadência diária", async () => {
    const { deps: d, enqueued } = deps();

    await triggerDecisionOutcomesMeasurement(d);

    expect(enqueued.every((e) => e.dedupeKey.endsWith(":2026-08-23"))).toBe(true);
  });

  it("contabiliza deduplicados separadamente de enfileirados", async () => {
    const { deps: d } = deps({ deduplicateOrgId: "org-2" });

    const outcome = await triggerDecisionOutcomesMeasurement(d);

    expect(outcome).toEqual({ organizationsScanned: 2, enqueued: 1, deduplicated: 1 });
  });

  it("devolve zero sem lançar quando a listagem de organizações falha", async () => {
    const { deps: d, enqueued } = deps({ organizationsFail: true });

    const outcome = await triggerDecisionOutcomesMeasurement(d);

    expect(outcome).toEqual({ organizationsScanned: 0, enqueued: 0, deduplicated: 0 });
    expect(enqueued).toHaveLength(0);
  });

  it("sem nenhuma organização, não enfileira nada", async () => {
    const { deps: d, enqueued } = deps();
    d.db = { from: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) } as unknown as
      DecisionOutcomesScheduleDeps["db"];

    const outcome = await triggerDecisionOutcomesMeasurement(d);

    expect(outcome).toEqual({ organizationsScanned: 0, enqueued: 0, deduplicated: 0 });
    expect(enqueued).toHaveLength(0);
  });
});
