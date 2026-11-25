import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { ParsedOrder } from "./order-schema.js";
import type { PersistOrderContext } from "./persist-order.js";
import { persistOrder, prefetchOrders } from "./persist-order.js";

const CONTEXT: PersistOrderContext = {
  organizationId: "11111111-0000-4000-8000-000000000001",
  mlAccountId: "aaaaaaaa-0000-4000-8000-000000000001",
  eventSource: "sync",
};

function makeOrder(id: number): ParsedOrder {
  return {
    id,
    status: "paid",
    status_detail: null,
    date_created: "2026-08-20T12:00:00.000Z",
    date_closed: "2026-08-20T12:01:00.000Z",
    date_last_updated: "2026-08-20T12:01:00.000Z",
    last_updated: "2026-08-20T12:01:00.000Z",
    total_amount: 100,
    paid_amount: 100,
    currency_id: "BRL",
    pack_id: null,
    buyer: { id: 12345 },
    tags: ["paid"],
    cancel_detail: null,
    order_items: [
      {
        item: {
          id: `MLB${String(id)}`,
          title: "Item",
          variation_id: null,
          seller_sku: null,
          user_product_id: `MLBU${String(id)}`,
        },
        quantity: 1,
        unit_price: 100,
        sale_fee: 10,
        currency_id: "BRL",
      },
    ],
  };
}

interface RecordedQuery {
  table: string;
  eqs: [string, unknown][];
  ins: [string, unknown[]][];
}

function createRecordingDb(): {
  db: Parameters<typeof prefetchOrders>[0];
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];

  const db = {
    from: (table: string) => ({
      select: () => {
        const record: RecordedQuery = { table, eqs: [], ins: [] };
        queries.push(record);
        const self = {
          eq: (col: string, val: unknown) => {
            record.eqs.push([col, val]);

            return self;
          },
          in: (col: string, vals: unknown[]) => {
            record.ins.push([col, vals]);

            return self;
          },
          is: () => self,
          gte: () => self,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          then: <T>(resolve: (value: { data: unknown[]; error: null }) => T) =>
            Promise.resolve({ data: [], error: null }).then(resolve),
        };

        return self;
      },
      upsert: () => Promise.resolve({ error: null }),
      delete: () => ({
        eq: () => ({
          gte: () => Promise.resolve({ error: null }),
        }),
      }),
      insert: () => Promise.resolve({ error: null }),
    }),
  } as unknown as Parameters<typeof prefetchOrders>[0];

  return { db, queries };
}

describe("persist-order hardening: lotes em orders.in() e escopo organization_id (D-827)", () => {
  it("prefetchOrders fatia orders.in('id', ...) em lotes de até 25 e filtra orders e sku_listing_links por organization_id", async () => {
    const { db, queries } = createRecordingDb();
    const orders = Array.from({ length: 60 }, (_, index) => makeOrder(2_000_000_000 + index));

    await prefetchOrders(db, CONTEXT, orders);

    const orderQueries = queries.filter((q) => q.table === "orders");
    expect(orderQueries.length).toBeGreaterThanOrEqual(3);

    for (const q of orderQueries) {
      const idIn = q.ins.find(([col]) => col === "id");
      expect(idIn).toBeDefined();
      expect((idIn?.[1] ?? []).length).toBeLessThanOrEqual(25);
      expect(q.eqs).toContainEqual(["organization_id", CONTEXT.organizationId]);
    }

    const linkQueries = queries.filter((q) => q.table === "sku_listing_links");
    expect(linkQueries.length).toBeGreaterThan(0);

    for (const q of linkQueries) {
      expect(q.eqs).toContainEqual(["organization_id", CONTEXT.organizationId]);
    }
  });

  it("persistOrder sem prefetch restringe leitura de orders à organization_id do contexto", async () => {
    const { db, queries } = createRecordingDb();
    const logger = createLogger({}, { sink: () => undefined });

    await persistOrder(db, CONTEXT, makeOrder(2_000_000_999), logger);

    const orderQueries = queries.filter((q) => q.table === "orders");
    expect(orderQueries).toHaveLength(1);
    expect(orderQueries[0]?.eqs).toContainEqual(["organization_id", CONTEXT.organizationId]);
  });
});
