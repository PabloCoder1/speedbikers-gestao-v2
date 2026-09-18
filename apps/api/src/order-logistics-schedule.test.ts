import { createLogger } from "@sb/observability";
import { describe, expect, it, vi } from "vitest";

import type { EnqueueRequest, Enqueuer } from "./enqueue.js";
import type { OrderLogisticsScheduleDeps } from "./order-logistics-schedule.js";
import { triggerOrderLogisticsSweep } from "./order-logistics-schedule.js";

const NOW = new Date("2026-09-18T12:30:00.000Z");

function fakeDb(accounts: { id: string; organization_id: string; slug: string }[] | null): OrderLogisticsScheduleDeps["db"] {
  return {
    from: () => ({
      select: () => ({
        eq: () =>
          Promise.resolve(
            accounts === null ? { data: null, error: { message: "boom" } } : { data: accounts, error: null },
          ),
      }),
    }),
  } as unknown as OrderLogisticsScheduleDeps["db"];
}

function fakeEnqueuer(deduplicated = false): { enqueuer: Enqueuer; requests: EnqueueRequest[] } {
  const requests: EnqueueRequest[] = [];

  const enqueuer: Enqueuer = {
    enqueue: vi.fn((request: EnqueueRequest) => {
      requests.push(request);

      return Promise.resolve({ taskName: "t", envelope: {} as never, deduplicated });
    }),
  };

  return { enqueuer, requests };
}

describe("triggerOrderLogisticsSweep (D-352, R2)", () => {
  it("enfileira um job por conta CONNECTED, na fila da conta", async () => {
    const { enqueuer, requests } = fakeEnqueuer();
    const deps: OrderLogisticsScheduleDeps = {
      db: fakeDb([
        { id: "acc-1", organization_id: "org-1", slug: "loja-1" },
        { id: "acc-2", organization_id: "org-1", slug: "loja-2" },
      ]),
      enqueuer,
      logger: createLogger({}, { sink: () => undefined }),
      now: () => NOW,
    };

    const outcome = await triggerOrderLogisticsSweep(deps);

    expect(outcome).toEqual({ accountsScanned: 2, enqueued: 2, deduplicated: 0 });
    expect(requests[0]).toMatchObject({
      jobType: "sync.order-logistics",
      queue: "ml-sync-loja-1",
      payload: { mlAccountId: "acc-1" },
    });
  });

  it("o dedupe é por HORA, não por dia: o backlog é drenado com rodadas repetidas no mesmo dia", async () => {
    const { enqueuer, requests } = fakeEnqueuer();
    const deps: OrderLogisticsScheduleDeps = {
      db: fakeDb([{ id: "acc-1", organization_id: "org-1", slug: "loja-1" }]),
      enqueuer,
      logger: createLogger({}, { sink: () => undefined }),
      now: () => NOW,
    };

    await triggerOrderLogisticsSweep(deps);
    await triggerOrderLogisticsSweep({ ...deps, now: () => new Date("2026-09-18T18:05:00.000Z") });

    expect(requests.map((request) => request.dedupeKey)).toEqual([
      "order-logistics:loja-1:2026-09-18T12",
      "order-logistics:loja-1:2026-09-18T18",
    ]);
  });

  it("falha ao listar contas não lança — zero varrido, com log de erro", async () => {
    const { enqueuer, requests } = fakeEnqueuer();
    const deps: OrderLogisticsScheduleDeps = {
      db: fakeDb(null),
      enqueuer,
      logger: createLogger({}, { sink: () => undefined }),
      now: () => NOW,
    };

    const outcome = await triggerOrderLogisticsSweep(deps);

    expect(outcome).toEqual({ accountsScanned: 0, enqueued: 0, deduplicated: 0 });
    expect(requests).toHaveLength(0);
  });
});
