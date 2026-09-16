import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { AdsScheduleDeps } from "./ads-schedule.js";
import { triggerAdsCampaignsSync } from "./ads-schedule.js";
import type { EnqueueRequest } from "./enqueue.js";

const ACCOUNTS = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", organization_id: "org-1", slug: "speedbikers-loja-1" },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", organization_id: "org-1", slug: "sbmotos" },
];

function montar(options: { accountsFail?: boolean; deduplicateSlug?: string } = {}): {
  deps: AdsScheduleDeps;
  enqueued: EnqueueRequest[];
} {
  const enqueued: EnqueueRequest[] = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: () =>
          Promise.resolve(
            options.accountsFail === true ? { data: null, error: { message: "boom" } } : { data: ACCOUNTS, error: null },
          ),
      }),
    }),
  } as unknown as AdsScheduleDeps["db"];

  return {
    enqueued,
    deps: {
      db,
      logger: createLogger({}, { sink: () => undefined }),
      now: () => new Date("2026-09-16T14:05:00.000Z"),
      enqueuer: {
        enqueue: (request) => {
          enqueued.push(request);

          return Promise.resolve({
            taskName: "t",
            deduplicated: options.deduplicateSlug !== undefined && request.queue === `ml-sync-${options.deduplicateSlug}`,
            envelope: {
              jobType: request.jobType,
              jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b22",
              organizationId: request.organizationId,
              dedupeKey: request.dedupeKey,
              attempt: 1,
              enqueuedAt: "2026-09-16T14:05:00.000Z",
            },
          });
        },
      },
    },
  };
}

describe("triggerAdsCampaignsSync", () => {
  it("uma task sync.ads.campaigns por conta, na fila da conta, com a data de negócio na chave", async () => {
    const { deps, enqueued } = montar();

    await expect(triggerAdsCampaignsSync(deps)).resolves.toEqual({ accountsScanned: 2, enqueued: 2, deduplicated: 0 });

    // Ordem por slug, não pela ordem do banco.
    expect(enqueued.map((e) => e.queue)).toEqual(["ml-sync-sbmotos", "ml-sync-speedbikers-loja-1"]);
    expect(enqueued[0]).toMatchObject({
      jobType: "sync.ads.campaigns",
      dedupeKey: "ads:sbmotos:2026-09-16",
      payload: { mlAccountId: "aaaaaaaa-0000-4000-8000-000000000002" },
    });
    expect(enqueued[0]?.delaySeconds).toBeUndefined();
    expect(enqueued[1]?.delaySeconds).toBe(300);
  });

  it("conta a deduplicação à parte", async () => {
    const { deps } = montar({ deduplicateSlug: "sbmotos" });

    await expect(triggerAdsCampaignsSync(deps)).resolves.toEqual({ accountsScanned: 2, enqueued: 1, deduplicated: 1 });
  });

  it("falha ao listar contas não enfileira nada", async () => {
    const { deps, enqueued } = montar({ accountsFail: true });

    await expect(triggerAdsCampaignsSync(deps)).resolves.toEqual({ accountsScanned: 0, enqueued: 0, deduplicated: 0 });
    expect(enqueued).toHaveLength(0);
  });
});
