import { parseTikTokJobPayload } from "@sb/contracts";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import type { EnqueueRequest } from "./enqueue.js";
import {
  TIKTOK_ITEMS_DELAY_S,
  TIKTOK_SHOPS_PAGE_SIZE,
  triggerTikTokOrdersSync,
  type TikTokOrdersScheduleDeps,
} from "./tiktok-orders-schedule.js";

const NOW = new Date("2026-11-24T14:25:00.000Z");

function createFakeDeps(
  options: {
    shops?: { id: string; organization_id: string }[];
    dbError?: string;
    failSecondPage?: boolean;
    failShopId?: string;
    deduplicateAll?: boolean;
  } = {},
) {
  const shops = options.shops ?? [
    { id: "shop-1", organization_id: "org-1" },
    { id: "shop-2", organization_id: "org-2" },
  ];
  const enqueued: EnqueueRequest[] = [];
  const logs: Record<string, unknown>[] = [];
  let pageCount = 0;

  const db = {
    from: () => ({
      select: () => ({
        eq: () => {
          let afterId: string | null = null;
          const chain = {
            order: () => chain,
            gt: (_col: string, val: string) => {
              afterId = val;

              return chain;
            },
            limit: (n: number) => {
              pageCount += 1;

              if (options.dbError !== undefined) {
                return Promise.resolve({ data: null, error: { message: options.dbError } });
              }

              if (options.failSecondPage === true && pageCount >= 2) {
                return Promise.resolve({ data: null, error: { message: "timeout na pagina 2" } });
              }

              const filtered = afterId === null ? shops : shops.filter((shop) => shop.id > afterId!);

              return Promise.resolve({ data: filtered.slice(0, n), error: null });
            },
          };

          return chain;
        },
      }),
    }),
  } as unknown as TikTokOrdersScheduleDeps["db"];

  const deps: TikTokOrdersScheduleDeps = {
    db,
    logger: createLogger({}, { sink: (line) => logs.push(JSON.parse(line) as Record<string, unknown>) }),
    now: () => NOW,
    enqueuer: {
      enqueue: (request) => {
        if (options.failShopId !== undefined && request.payload?.tiktokShopId === options.failShopId) {
          return Promise.reject(new Error("Cloud Tasks fora"));
        }

        enqueued.push(request);

        return Promise.resolve({
          taskName: "t",
          envelope: {} as never,
          deduplicated: options.deduplicateAll === true,
        });
      },
    },
  };

  return { deps, enqueued, logs };
}

describe("POST /internal/schedule/tiktok-orders (D-810)", () => {
  it("enfileira pedidos e catálogo (+300s) para todas as lojas CONNECTED com deduplicação horária", async () => {
    const { deps, enqueued } = createFakeDeps();
    const outcome = await triggerTikTokOrdersSync(deps);

    expect(TIKTOK_ITEMS_DELAY_S).toBe(300);
    expect(outcome).toEqual({ shopsScanned: 2, enqueued: 4, deduplicated: 0 });
    expect(enqueued).toEqual([
      {
        jobType: "tiktok.orders.sync",
        organizationId: "org-1",
        dedupeKey: "tiktok-orders:shop-1:hora:2026-11-24T14",
        queue: "backfill",
        payload: { tiktokShopId: "shop-1" },
      },
      {
        jobType: "tiktok.items.sync",
        organizationId: "org-1",
        dedupeKey: "tiktok-items:shop-1:hora:2026-11-24T14",
        queue: "backfill",
        payload: { tiktokShopId: "shop-1" },
        delaySeconds: 300,
      },
      {
        jobType: "tiktok.orders.sync",
        organizationId: "org-2",
        dedupeKey: "tiktok-orders:shop-2:hora:2026-11-24T14",
        queue: "backfill",
        payload: { tiktokShopId: "shop-2" },
      },
      {
        jobType: "tiktok.items.sync",
        organizationId: "org-2",
        dedupeKey: "tiktok-items:shop-2:hora:2026-11-24T14",
        queue: "backfill",
        payload: { tiktokShopId: "shop-2" },
        delaySeconds: 300,
      },
    ]);
  });

  it("pagina além de 1.000 lojas sem truncar e falha fechado em erro de banco", async () => {
    const muitasLojas = Array.from({ length: TIKTOK_SHOPS_PAGE_SIZE + 5 }, (_, i) => ({
      id: `shop-${String(i).padStart(4, "0")}`,
      organization_id: "org-1",
    }));
    const { deps, enqueued } = createFakeDeps({ shops: muitasLojas });
    const outcome = await triggerTikTokOrdersSync(deps);

    expect(outcome).toEqual({
      shopsScanned: TIKTOK_SHOPS_PAGE_SIZE + 5,
      enqueued: (TIKTOK_SHOPS_PAGE_SIZE + 5) * 2,
      deduplicated: 0,
    });
    expect(enqueued).toHaveLength((TIKTOK_SHOPS_PAGE_SIZE + 5) * 2);

    const erroDb = createFakeDeps({ dbError: "db fora" });

    expect(await triggerTikTokOrdersSync(erroDb.deps)).toEqual({
      shopsScanned: 0,
      enqueued: 0,
      deduplicated: 0,
      failed: true,
    });

    const erroPagina2 = createFakeDeps({ shops: muitasLojas, failSecondPage: true });

    expect(await triggerTikTokOrdersSync(erroPagina2.deps)).toMatchObject({ failed: true });
    expect(erroPagina2.enqueued).toEqual([]);
  });

  it("isola falha de enqueue por loja, segue nas demais e rota HTTP responde 503 para retentativa", async () => {
    const { deps, enqueued, logs } = createFakeDeps({ failShopId: "shop-1" });
    const app = createApp({
      logger: deps.logger,
      tiktokOrdersSchedule: deps,
      oidc: { verify: () => Promise.resolve({ ok: true, email: "scheduler@exemplo.com" }) },
    });

    const res = await app.request("/internal/schedule/tiktok-orders", { method: "POST" });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ shopsScanned: 2, enqueued: 2, deduplicated: 0, failed: true });
    expect(enqueued.map((item) => item.payload?.tiktokShopId)).toEqual(["shop-2", "shop-2"]);
    expect(logs.some((entry) => entry.message === "tiktok_orders_schedule_enqueue_failed")).toBe(true);
  });

  it("exige OIDC e devolve 503 not_configured quando o agendador TikTok não está ligado", async () => {
    const app = createApp({
      logger: createLogger({}, { sink: () => undefined }),
      oidc: { verify: () => Promise.resolve({ ok: true, email: "scheduler@exemplo.com" }) },
    });

    const notConfigured = await app.request("/internal/schedule/tiktok-orders", { method: "POST" });

    expect(notConfigured.status).toBe(503);
    expect(await notConfigured.json()).toEqual({ error: { code: "not_configured" } });
  });

  it("todos os jobs enfileirados com UUID real passam no contrato compartilhado @sb/contracts (D-812)", async () => {
    const { deps, enqueued } = createFakeDeps({
      shops: [{ id: "bbbbbbbb-0000-4000-8000-0000000000b1", organization_id: "aaaaaaaa-0000-4000-8000-0000000000a1" }],
    });
    await triggerTikTokOrdersSync(deps);

    expect(enqueued).toHaveLength(2);
    for (const item of enqueued) {
      expect(parseTikTokJobPayload(item.jobType, item.payload).success).toBe(true);
    }
  });
});
