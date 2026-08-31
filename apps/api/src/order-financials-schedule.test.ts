import { createLogger } from "@sb/observability";
import { describe, expect, it, vi } from "vitest";

import type { EnqueueRequest, Enqueuer } from "./enqueue.js";
import type { OrderFinancialsScheduleDeps } from "./order-financials-schedule.js";
import { triggerOrderFinancialsSweep } from "./order-financials-schedule.js";

const NOW = new Date("2026-08-31T12:30:00.000Z");

function fakeDb(accounts: { id: string; organization_id: string; slug: string }[] | null): OrderFinancialsScheduleDeps["db"] {
  return {
    from: () => ({
      select: () => ({
        eq: () =>
          Promise.resolve(
            accounts === null ? { data: null, error: { message: "boom" } } : { data: accounts, error: null },
          ),
      }),
    }),
  } as unknown as OrderFinancialsScheduleDeps["db"];
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

describe("triggerOrderFinancialsSweep (D-165)", () => {
  it("enfileira um job por conta CONNECTED, na fila da conta, com dedupe por dia de negócio", async () => {
    const { enqueuer, requests } = fakeEnqueuer();
    const deps: OrderFinancialsScheduleDeps = {
      db: fakeDb([
        { id: "acc-1", organization_id: "org-1", slug: "loja-1" },
        { id: "acc-2", organization_id: "org-1", slug: "loja-2" },
      ]),
      enqueuer,
      logger: createLogger({}, { sink: () => undefined }),
      now: () => NOW,
    };

    const outcome = await triggerOrderFinancialsSweep(deps);

    expect(outcome).toEqual({ accountsScanned: 2, enqueued: 2, deduplicated: 0 });
    expect(requests[0]).toMatchObject({
      jobType: "sync.order-financials",
      queue: "ml-sync-loja-1",
      dedupeKey: "order-financials:loja-1:2026-08-31",
      payload: { mlAccountId: "acc-1" },
    });
  });

  it("falha ao listar contas não lança — zero varrido, com log de erro", async () => {
    const { enqueuer, requests } = fakeEnqueuer();
    const deps: OrderFinancialsScheduleDeps = {
      db: fakeDb(null),
      enqueuer,
      logger: createLogger({}, { sink: () => undefined }),
      now: () => NOW,
    };

    const outcome = await triggerOrderFinancialsSweep(deps);

    expect(outcome).toEqual({ accountsScanned: 0, enqueued: 0, deduplicated: 0 });
    expect(requests).toHaveLength(0);
  });
});
