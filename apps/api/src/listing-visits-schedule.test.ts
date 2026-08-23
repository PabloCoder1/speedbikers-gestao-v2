import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { EnqueueRequest } from "./enqueue.js";
import type { ListingVisitsScheduleDeps } from "./listing-visits-schedule.js";
import { triggerListingVisitsSnapshot } from "./listing-visits-schedule.js";

const ACCOUNTS = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", organization_id: "org-1", slug: "speedbikers-loja-1" },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", organization_id: "org-1", slug: "sbmotos" },
];

function fakeDb(options: { accountsFail?: boolean } = {}): ListingVisitsScheduleDeps["db"] {
  return {
    from: () => ({
      select: () => ({
        eq: () =>
          Promise.resolve(
            options.accountsFail === true
              ? { data: null, error: { message: "boom" } }
              : { data: ACCOUNTS, error: null },
          ),
      }),
    }),
  } as unknown as ListingVisitsScheduleDeps["db"];
}

function deps(options: {
  accountsFail?: boolean;
  deduplicateSlug?: string;
} = {}): { deps: ListingVisitsScheduleDeps; enqueued: EnqueueRequest[] } {
  const enqueued: EnqueueRequest[] = [];

  return {
    enqueued,
    deps: {
      db: fakeDb(options),
      logger: createLogger({}, { sink: () => undefined }),
      now: () => new Date("2026-08-23T18:15:00.000Z"),
      enqueuer: {
        enqueue: (request) => {
          enqueued.push(request);

          return Promise.resolve({
            taskName: "t",
            deduplicated: request.queue.endsWith(options.deduplicateSlug ?? "__none__"),
            envelope: {
              jobType: request.jobType,
              jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b22",
              organizationId: request.organizationId,
              dedupeKey: request.dedupeKey,
              attempt: 1,
              enqueuedAt: "2026-08-23T18:15:00.000Z",
            },
          });
        },
      },
    },
  };
}

describe("triggerListingVisitsSnapshot (D-032)", () => {
  it("enfileira sync.listing-visits.snapshot para cada conta CONNECTED, uma vez cada", async () => {
    const { deps: d, enqueued } = deps();

    const outcome = await triggerListingVisitsSnapshot(d);

    expect(outcome).toEqual({ accountsScanned: 2, enqueued: 2, deduplicated: 0 });
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]).toMatchObject({
      jobType: "sync.listing-visits.snapshot",
      organizationId: "org-1",
      queue: "ml-sync-speedbikers-loja-1",
      dedupeKey: "listing-visits:speedbikers-loja-1:2026-08-23",
      payload: { mlAccountId: ACCOUNTS[0]?.id },
    });
  });

  it("a chave de dedupe é o dia de negócio — mesmo dia produz a mesma chave (cadência diária, não a cada 6h)", async () => {
    const { deps: d, enqueued } = deps();

    await triggerListingVisitsSnapshot(d);

    expect(enqueued.every((e) => e.dedupeKey.endsWith(":2026-08-23"))).toBe(true);
  });

  it("contabiliza deduplicados separadamente de enfileirados", async () => {
    const { deps: d } = deps({ deduplicateSlug: "sbmotos" });

    const outcome = await triggerListingVisitsSnapshot(d);

    expect(outcome).toEqual({ accountsScanned: 2, enqueued: 1, deduplicated: 1 });
  });

  it("devolve zero sem lançar quando a listagem de contas falha", async () => {
    const { deps: d, enqueued } = deps({ accountsFail: true });

    const outcome = await triggerListingVisitsSnapshot(d);

    expect(outcome).toEqual({ accountsScanned: 0, enqueued: 0, deduplicated: 0 });
    expect(enqueued).toHaveLength(0);
  });

  it("sem conta CONNECTED nenhuma, não enfileira nada", async () => {
    const { deps: d, enqueued } = deps();
    d.db = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
    } as unknown as ListingVisitsScheduleDeps["db"];

    const outcome = await triggerListingVisitsSnapshot(d);

    expect(outcome).toEqual({ accountsScanned: 0, enqueued: 0, deduplicated: 0 });
    expect(enqueued).toHaveLength(0);
  });
});
