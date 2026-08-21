import { describe, expect, it } from "vitest";

import type { ParsedOrder } from "./order-schema.js";
import type { PersistOrderContext } from "./persist-order.js";
import { persistOrder } from "./persist-order.js";

const CONTEXT: PersistOrderContext = {
  organizationId: "11111111-0000-4000-8000-000000000001",
  mlAccountId: "aaaaaaaa-0000-4000-8000-000000000001",
};

const BASE_ORDER: ParsedOrder = {
  id: 2_032_217_210,
  status: "paid",
  status_detail: null,
  date_created: "2019-05-22T03:51:05.000-04:00",
  date_closed: "2019-05-22T03:51:07.000-04:00",
  date_last_updated: "2020-02-14T02:55:49.811Z",
  last_updated: "2019-05-28T15:16:04.000-04:00",
  total_amount: 129.95,
  paid_amount: 129.95,
  currency_id: "BRL",
  pack_id: null,
  buyer: { id: 89_660_613 },
  tags: ["delivered", "paid"],
  cancel_detail: null,
  order_items: [
    {
      item: { id: "MLB1054990648", title: "Kit Com 03 Adesivo", variation_id: null, seller_sku: null },
      quantity: 1,
      unit_price: 129.95,
      sale_fee: 14.29,
      currency_id: "BRL",
    },
  ],
};

/** Chain genérica que acumula filtros por nome de coluna — o terminal decide a resposta a partir deles. */
function filterChain(
  filters: Record<string, unknown>,
  resolve: (filters: Record<string, unknown>) => { data: unknown; error: unknown },
): {
  eq: (col: string, val: unknown) => ReturnType<typeof filterChain>;
  is: (col: string, val: unknown) => ReturnType<typeof filterChain>;
  select: () => ReturnType<typeof filterChain>;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
} {
  const self = {
    eq: (col: string, val: unknown) => filterChain({ ...filters, [col]: val }, resolve),
    is: (col: string) => filterChain({ ...filters, [col]: null }, resolve),
    select: () => self,
    maybeSingle: () => Promise.resolve(resolve(filters)),
  };

  return self;
}

interface FakeDbOptions {
  linkForItem?: (itemId: string, variationId: string | null) => { id: string; sku_id: string } | null;
}

function fakeDb(options: FakeDbOptions = {}): {
  db: Parameters<typeof persistOrder>[0];
  upserted: { table: string; row: unknown }[];
  deleted: { table: string; filters: Record<string, unknown> }[];
  inserted: { table: string; rows: unknown[] }[];
} {
  const upserted: { table: string; row: unknown }[] = [];
  const deleted: { table: string; filters: Record<string, unknown> }[] = [];
  const inserted: { table: string; rows: unknown[] }[] = [];

  const db = {
    from: (table: string) => ({
      upsert: (row: unknown) => {
        upserted.push({ table, row });

        return Promise.resolve({ data: null, error: null });
      },
      delete: () => ({
        eq: (col: string, val: unknown) => {
          deleted.push({ table, filters: { [col]: val } });

          return Promise.resolve({ data: null, error: null });
        },
      }),
      insert: (rows: unknown[]) => {
        inserted.push({ table, rows });

        return Promise.resolve({ data: null, error: null });
      },
      select: () =>
        filterChain({}, (filters) => {
          const itemId = filters.item_id as string;
          const variationId = (filters.variation_id as string | null | undefined) ?? null;
          const link = options.linkForItem?.(itemId, variationId) ?? null;

          return { data: link, error: null };
        }),
    }),
  } as unknown as Parameters<typeof persistOrder>[0];

  return { db, upserted, deleted, inserted };
}

describe("persistOrder", () => {
  it("grava a order com os campos mapeados corretamente", async () => {
    const { db, upserted } = fakeDb();

    await persistOrder(db, CONTEXT, BASE_ORDER);

    const orderUpsert = upserted.find((entry) => entry.table === "orders");
    expect(orderUpsert?.row).toMatchObject({
      id: 2_032_217_210,
      organization_id: CONTEXT.organizationId,
      ml_account_id: CONTEXT.mlAccountId,
      pack_id: null,
      status: "paid",
      date_created: BASE_ORDER.date_created,
      date_closed: BASE_ORDER.date_closed,
      date_last_updated: BASE_ORDER.date_last_updated,
      last_updated: BASE_ORDER.last_updated,
      total_amount: 129.95,
      paid_amount: 129.95,
      currency_id: "BRL",
      buyer_id: 89_660_613,
      tags: ["delivered", "paid"],
      cancel_reason: null,
    });
  });

  it("usa a description de cancel_detail como cancel_reason quando presente", async () => {
    const { db, upserted } = fakeDb();
    const order: ParsedOrder = {
      ...BASE_ORDER,
      status: "cancelled",
      cancel_detail: { description: "Vendedor cancelou por falta de estoque" },
    };

    await persistOrder(db, CONTEXT, order);

    const orderUpsert = upserted.find((entry) => entry.table === "orders");
    expect((orderUpsert?.row as { cancel_reason: string }).cancel_reason).toBe(
      "Vendedor cancelou por falta de estoque",
    );
  });

  it("campos ausentes (tags, pack_id, buyer) viram null/[] em vez de undefined", async () => {
    const { db, upserted } = fakeDb();
    const order: ParsedOrder = {
      ...BASE_ORDER,
      pack_id: undefined,
      buyer: undefined,
      tags: undefined,
    };

    await persistOrder(db, CONTEXT, order);

    const orderUpsert = upserted.find((entry) => entry.table === "orders");
    expect(orderUpsert?.row).toMatchObject({ pack_id: null, buyer_id: null, tags: [] });
  });

  it("apaga os order_items existentes antes de inserir os novos — reprocessar substitui tudo", async () => {
    const { db, deleted, inserted } = fakeDb();

    await persistOrder(db, CONTEXT, BASE_ORDER);

    expect(deleted).toEqual([{ table: "order_items", filters: { order_id: BASE_ORDER.id } }]);
    expect(inserted.find((entry) => entry.table === "order_items")).toBeDefined();
  });

  it("não insere nada em order_items quando o pedido não tem itens", async () => {
    const { db, deleted, inserted } = fakeDb();
    const order: ParsedOrder = { ...BASE_ORDER, order_items: [] };

    await persistOrder(db, CONTEXT, order);

    expect(deleted).toHaveLength(1);
    expect(inserted.find((entry) => entry.table === "order_items")).toBeUndefined();
  });

  it("grava position por índice do array, preservando a ordem original", async () => {
    const { db, inserted } = fakeDb();
    const order: ParsedOrder = {
      ...BASE_ORDER,
      order_items: [
        { item: { id: "MLB1", title: "Item 1" }, quantity: 1, unit_price: 10, currency_id: "BRL" },
        { item: { id: "MLB2", title: "Item 2" }, quantity: 2, unit_price: 20, currency_id: "BRL" },
      ],
    };

    await persistOrder(db, CONTEXT, order);

    const rows = inserted.find((entry) => entry.table === "order_items")?.rows as { position: number; item_id: string }[];
    expect(rows).toEqual([
      expect.objectContaining({ position: 0, item_id: "MLB1" }),
      expect.objectContaining({ position: 1, item_id: "MLB2" }),
    ]);
  });

  it("resolve sku_id e sku_listing_link_id pelo vínculo vigente (D-020)", async () => {
    const { db, inserted } = fakeDb({
      linkForItem: (itemId, variationId) =>
        itemId === "MLB1054990648" && variationId === null
          ? { id: "link-1", sku_id: "sku-1" }
          : null,
    });

    await persistOrder(db, CONTEXT, BASE_ORDER);

    const rows = inserted.find((entry) => entry.table === "order_items")?.rows as {
      sku_id: string | null;
      sku_listing_link_id: string | null;
    }[];
    expect(rows[0]).toMatchObject({ sku_id: "sku-1", sku_listing_link_id: "link-1" });
  });

  it("sem vínculo correspondente, grava sku_id e sku_listing_link_id nulos — não é erro", async () => {
    const { db, inserted } = fakeDb();

    await persistOrder(db, CONTEXT, BASE_ORDER);

    const rows = inserted.find((entry) => entry.table === "order_items")?.rows as {
      sku_id: string | null;
      sku_listing_link_id: string | null;
    }[];
    expect(rows[0]).toMatchObject({ sku_id: null, sku_listing_link_id: null });
  });

  it("converte variation_id numérico para texto, igual à coluna de sku_listing_links", async () => {
    const { db, inserted } = fakeDb({
      linkForItem: (itemId, variationId) =>
        itemId === "MLB2608564035" && variationId === "174390848694"
          ? { id: "link-2", sku_id: "sku-2" }
          : null,
    });

    const order: ParsedOrder = {
      ...BASE_ORDER,
      order_items: [
        {
          item: { id: "MLB2608564035", title: "Camiseta", variation_id: 174_390_848_694, seller_sku: null },
          quantity: 1,
          unit_price: 50,
          currency_id: "BRL",
        },
      ],
    };

    await persistOrder(db, CONTEXT, order);

    const rows = inserted.find((entry) => entry.table === "order_items")?.rows as {
      variation_id: string | null;
      sku_id: string | null;
    }[];
    expect(rows[0]).toMatchObject({ variation_id: "174390848694", sku_id: "sku-2" });
  });
});
