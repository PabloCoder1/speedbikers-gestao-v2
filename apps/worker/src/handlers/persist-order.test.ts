import { createLogger } from "@sb/observability";
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

/**
 * Chain genérica que acumula filtros por nome de coluna — o terminal decide
 * a resposta a partir deles. Também é "thenable": `loadSkuKindAndComponents`
 * consulta `sku_components` sem `.maybeSingle()` (o resultado é uma lista),
 * então `await` direto na chain precisa resolver — mesmo formato do
 * query builder real do supabase-js.
 */
function filterChain(
  filters: Record<string, unknown>,
  resolve: (filters: Record<string, unknown>) => { data: unknown; error: unknown },
): {
  eq: (col: string, val: unknown) => ReturnType<typeof filterChain>;
  is: (col: string, val: unknown) => ReturnType<typeof filterChain>;
  select: () => ReturnType<typeof filterChain>;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  then: <T>(
    onFulfilled: (value: { data: unknown; error: unknown }) => T,
  ) => Promise<T>;
} {
  const self = {
    eq: (col: string, val: unknown) => filterChain({ ...filters, [col]: val }, resolve),
    is: (col: string) => filterChain({ ...filters, [col]: null }, resolve),
    select: () => self,
    maybeSingle: () => Promise.resolve(resolve(filters)),
    then: <T>(onFulfilled: (value: { data: unknown; error: unknown }) => T) =>
      Promise.resolve(resolve(filters)).then(onFulfilled),
  };

  return self;
}

interface FakeDbOptions {
  linkForItem?: (itemId: string, variationId: string | null) => { id: string; sku_id: string } | null;
  /** Status da order já gravada, ANTES desta chamada — o "before" do motor de diff. */
  previousStatus?: string | null;
  /** Simula violação de `dedup_key` (23505) no insert de `domain_events`. */
  domainEventConflict?: boolean;
  /** Simula uma falha REAL (não-dedup) no insert de `domain_events`. */
  domainEventError?: boolean;
  /** `kind` de cada SKU consultado por `loadSkuKindAndComponents` — default PRODUTO. */
  skuKindById?: (skuId: string) => "PRODUTO" | "KIT";
  /** Componentes de um SKU kit, por `kit_sku_id`. */
  componentsByKitId?: (kitSkuId: string) => { component_sku_id: string; quantity: number }[];
  /** Simula violação de `idempotency_key` (23505) no insert de `stock_movements`. */
  stockMovementConflict?: boolean;
  /** Simula uma falha REAL (não-dedup) no insert de `stock_movements`. */
  stockMovementError?: boolean;
  /** Movimentos `VENDA_ML` já gravados para a order — o que `loadSaleMovements` devolve. */
  existingSaleMovements?: { sku_id: string; qty_delta: number; idempotency_key: string }[];
  /** Simula falha (não conflito) ao ler o status anterior da order. */
  previousStatusError?: boolean;
  /** Simula falha ao ler stock_movements existentes (loadSaleMovements). */
  saleMovementsError?: boolean;
  /** Simula falha ao resolver sku_listing_links (resolveSku). */
  linkLookupError?: boolean;
  /** Simula falha ao ler o kind do SKU (loadSkuKindAndComponents, primeira query). */
  skuKindError?: boolean;
  /** Simula falha ao ler os componentes do kit (loadSkuKindAndComponents, segunda query). */
  componentsError?: boolean;
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

  function writeAppendOnly(table: string, row: unknown): Promise<{ data: null; error: unknown }> {
    inserted.push({ table, rows: Array.isArray(row) ? row : [row] });

    if (table === "domain_events" && options.domainEventConflict === true) {
      return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
    }

    if (table === "domain_events" && options.domainEventError === true) {
      return Promise.resolve({ data: null, error: { code: "42P01", message: "boom" } });
    }

    if (table === "stock_movements" && options.stockMovementConflict === true) {
      return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
    }

    if (table === "stock_movements" && options.stockMovementError === true) {
      return Promise.resolve({ data: null, error: { code: "42P01", message: "boom" } });
    }

    return Promise.resolve({ data: null, error: null });
  }

  const db = {
    from: (table: string) => ({
      upsert: (row: unknown) => {
        // `domain_events` e `stock_movements` passaram a gravar por upsert
        // (ON CONFLICT DO NOTHING, D-092) em vez de INSERT com o 23505
        // absorvido no cliente. Continuam sendo contabilizados em `inserted`:
        // o que os testes verificam é O QUE foi gravado, não o verbo.
        if (table === "domain_events" || table === "stock_movements") {
          return writeAppendOnly(table, row);
        }

        upserted.push({ table, row });

        return Promise.resolve({ data: null, error: null });
      },
      delete: () => ({
        eq: (col: string, val: unknown) => {
          deleted.push({ table, filters: { [col]: val } });

          return Promise.resolve({ data: null, error: null });
        },
      }),
      insert: (row: unknown) => writeAppendOnly(table, row),
      // Tabela importa: `skus`/`sku_components` (dedução de estoque) e
      // `sku_listing_links` (resolução de vínculo) têm formas de filtro
      // e resposta diferentes — misturar os três faria um passar pelo
      // outro em silêncio.
      select: () => {
        if (table === "orders") {
          return filterChain({}, () => {
            if (options.previousStatusError === true) {
              return { data: null, error: { code: "42P01", message: "boom" } };
            }

            return {
              data: "previousStatus" in options ? { status: options.previousStatus } : null,
              error: null,
            };
          });
        }

        if (table === "skus") {
          return filterChain({}, (filters) => {
            if (options.skuKindError === true) {
              return { data: null, error: { code: "42P01", message: "boom" } };
            }

            const skuId = filters.id as string;

            return { data: { kind: options.skuKindById?.(skuId) ?? "PRODUTO" }, error: null };
          });
        }

        if (table === "sku_components") {
          return filterChain({}, (filters) => {
            if (options.componentsError === true) {
              return { data: null, error: { code: "42P01", message: "boom" } };
            }

            const kitSkuId = filters.kit_sku_id as string;

            return { data: options.componentsByKitId?.(kitSkuId) ?? [], error: null };
          });
        }

        if (table === "stock_movements") {
          return filterChain({}, () => {
            if (options.saleMovementsError === true) {
              return { data: null, error: { code: "42P01", message: "boom" } };
            }

            return { data: options.existingSaleMovements ?? [], error: null };
          });
        }

        return filterChain({}, (filters) => {
          if (options.linkLookupError === true) {
            return { data: null, error: { code: "42P01", message: "boom" } };
          }

          const itemId = filters.item_id as string;
          const variationId = (filters.variation_id as string | null | undefined) ?? null;
          const link = options.linkForItem?.(itemId, variationId) ?? null;

          return { data: link, error: null };
        });
      },
    }),
  } as unknown as Parameters<typeof persistOrder>[0];

  return { db, upserted, deleted, inserted };
}

function run(db: Parameters<typeof persistOrder>[0], order: ParsedOrder, lines: string[] = []) {
  return persistOrder(db, CONTEXT, order, createLogger({}, { sink: (line) => lines.push(line) }));
}

describe("persistOrder", () => {
  it("grava a order com os campos mapeados corretamente", async () => {
    const { db, upserted } = fakeDb();

    await run(db, BASE_ORDER);

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

    await run(db, order);

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

    await run(db, order);

    const orderUpsert = upserted.find((entry) => entry.table === "orders");
    expect(orderUpsert?.row).toMatchObject({ pack_id: null, buyer_id: null, tags: [] });
  });

  it("apaga os order_items existentes antes de inserir os novos — reprocessar substitui tudo", async () => {
    const { db, deleted, inserted } = fakeDb();

    await run(db, BASE_ORDER);

    expect(deleted).toEqual([{ table: "order_items", filters: { order_id: BASE_ORDER.id } }]);
    expect(inserted.find((entry) => entry.table === "order_items")).toBeDefined();
  });

  it("não insere nada em order_items quando o pedido não tem itens", async () => {
    const { db, deleted, inserted } = fakeDb();
    const order: ParsedOrder = { ...BASE_ORDER, order_items: [] };

    await run(db, order);

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

    await run(db, order);

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

    await run(db, BASE_ORDER);

    const rows = inserted.find((entry) => entry.table === "order_items")?.rows as {
      sku_id: string | null;
      sku_listing_link_id: string | null;
    }[];
    expect(rows[0]).toMatchObject({ sku_id: "sku-1", sku_listing_link_id: "link-1" });
  });

  it("sem vínculo correspondente, grava sku_id e sku_listing_link_id nulos — não é erro", async () => {
    const { db, inserted } = fakeDb();

    await run(db, BASE_ORDER);

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

    await run(db, order);

    const rows = inserted.find((entry) => entry.table === "order_items")?.rows as {
      variation_id: string | null;
      sku_id: string | null;
    }[];
    expect(rows[0]).toMatchObject({ variation_id: "174390848694", sku_id: "sku-2" });
  });

  describe("motor de diff (domain_events)", () => {
    it("emite order.cancelled quando o status transiciona para cancelled", async () => {
      const { db, inserted } = fakeDb({ previousStatus: "paid" });
      const order: ParsedOrder = { ...BASE_ORDER, status: "cancelled" };

      await run(db, order);

      const event = inserted.find((entry) => entry.table === "domain_events")?.rows[0] as {
        event_type: string;
        entity_id: string;
        before: unknown;
        after: unknown;
        dedup_key: string;
      };
      expect(event).toMatchObject({
        event_type: "order.cancelled",
        entity_id: String(BASE_ORDER.id),
        before: { status: "paid" },
        after: { status: "cancelled" },
        dedup_key: `order.cancelled:${String(BASE_ORDER.id)}:cancelled`,
      });
    });

    it("não emite evento quando o status não muda para cancelamento", async () => {
      const { db, inserted } = fakeDb({ previousStatus: "payment_in_process" });
      const order: ParsedOrder = { ...BASE_ORDER, status: "paid" };

      await run(db, order);

      expect(inserted.find((entry) => entry.table === "domain_events")).toBeUndefined();
    });

    it("não reemite quando o pedido já estava cancelled — reprocessamento idempotente", async () => {
      const { db, inserted } = fakeDb({ previousStatus: "cancelled" });
      const order: ParsedOrder = { ...BASE_ORDER, status: "cancelled" };

      await run(db, order);

      expect(inserted.find((entry) => entry.table === "domain_events")).toBeUndefined();
    });

    it("usa order.date_last_updated como occurred_at — quando aconteceu, não quando o V3 notou", async () => {
      const { db, inserted } = fakeDb({ previousStatus: "paid" });
      const order: ParsedOrder = { ...BASE_ORDER, status: "cancelled", date_last_updated: "2020-02-14T02:55:49.811Z" };

      await run(db, order);

      const event = inserted.find((entry) => entry.table === "domain_events")?.rows[0] as { occurred_at: string };
      expect(event.occurred_at).toBe("2020-02-14T02:55:49.811Z");
    });

    it("sem date_last_updated (GET por id, D-101): cai para last_updated, e sem os dois para date_created", async () => {
      // O relógio continua sendo o do Mercado Livre — a cascata usa só
      // campos do próprio pedido, nunca now().
      const { db, upserted } = fakeDb({ previousStatus: "paid" });
      const order: ParsedOrder = {
        ...BASE_ORDER,
        status: "cancelled",
        date_last_updated: undefined,
        last_updated: "2020-02-10T00:00:00.000Z",
      };

      await run(db, order);

      const row = upserted.find((entry) => entry.table === "orders")?.row as { date_last_updated: string };
      expect(row.date_last_updated).toBe("2020-02-10T00:00:00.000Z");

      const { db: db2, upserted: upserted2 } = fakeDb({ previousStatus: "paid" });
      const orderSoCreated: ParsedOrder = {
        ...BASE_ORDER,
        status: "cancelled",
        date_last_updated: undefined,
        last_updated: undefined,
      };

      await run(db2, orderSoCreated);

      const row2 = upserted2.find((entry) => entry.table === "orders")?.row as { date_last_updated: string };
      expect(row2.date_last_updated).toBe(BASE_ORDER.date_created);
    });

    it("conflito de dedup_key (23505) é absorvido em silêncio — é a deduplicação funcionando", async () => {
      const { db } = fakeDb({ previousStatus: "paid", domainEventConflict: true });
      const order: ParsedOrder = { ...BASE_ORDER, status: "cancelled" };
      const lines: string[] = [];

      await expect(run(db, order, lines)).resolves.toBeUndefined();
      expect(lines.join()).not.toContain("domain_event_not_recorded");
    });

    it("uma falha de gravação REAL em domain_events é logada, mas não derruba a persistência do pedido", async () => {
      const { db, upserted } = fakeDb({ previousStatus: "paid", domainEventError: true });
      const order: ParsedOrder = { ...BASE_ORDER, status: "cancelled" };
      const lines: string[] = [];

      await expect(run(db, order, lines)).resolves.toBeUndefined();
      expect(lines.join()).toContain("domain_event_not_recorded");
      expect(upserted.find((entry) => entry.table === "orders")).toBeDefined();
    });
  });

  describe("dedução de estoque por venda (stock_movements)", () => {
    it("PRODUTO vinculado e pedido pago: um movimento VENDA_ML com quantidade negativa", async () => {
      const { db, inserted } = fakeDb({
        linkForItem: () => ({ id: "link-1", sku_id: "sku-1" }),
      });

      await run(db, BASE_ORDER);

      const movement = inserted.find((entry) => entry.table === "stock_movements")?.rows[0] as {
        sku_id: string;
        location_kind: string;
        qty_delta: number;
        movement_type: string;
        source_type: string;
        source_id: string;
        idempotency_key: string;
      };

      expect(movement).toMatchObject({
        sku_id: "sku-1",
        location_kind: "LOCAL",
        qty_delta: -1,
        movement_type: "VENDA_ML",
        source_type: "ORDER",
        source_id: String(BASE_ORDER.id),
        idempotency_key: `venda:${String(BASE_ORDER.id)}:0`,
      });
    });

    it("KIT vinculado: um movimento por componente, quantidade multiplicada", async () => {
      const { db, inserted } = fakeDb({
        linkForItem: () => ({ id: "link-kit", sku_id: "sku-kit" }),
        skuKindById: () => "KIT",
        componentsByKitId: () => [
          { component_sku_id: "sku-lampada", quantity: 2 },
          { component_sku_id: "sku-suporte", quantity: 1 },
        ],
      });
      const order: ParsedOrder = {
        ...BASE_ORDER,
        order_items: [{ ...BASE_ORDER.order_items[0]!, quantity: 3 }],
      };

      await run(db, order);

      const movements = inserted
        .filter((entry) => entry.table === "stock_movements")
        .map((entry) => entry.rows[0]) as { sku_id: string; qty_delta: number }[];

      expect(movements).toEqual([
        expect.objectContaining({ sku_id: "sku-lampada", qty_delta: -6 }),
        expect.objectContaining({ sku_id: "sku-suporte", qty_delta: -3 }),
      ]);
    });

    it("status que não é venda válida não deduz estoque", async () => {
      const { db, inserted } = fakeDb({ linkForItem: () => ({ id: "link-1", sku_id: "sku-1" }) });
      const order: ParsedOrder = { ...BASE_ORDER, status: "confirmed" };

      await run(db, order);

      expect(inserted.find((entry) => entry.table === "stock_movements")).toBeUndefined();
    });

    it("item sem vínculo não deduz estoque", async () => {
      const { db, inserted } = fakeDb();

      await run(db, BASE_ORDER);

      expect(inserted.find((entry) => entry.table === "stock_movements")).toBeUndefined();
    });

    it("conflito de idempotency_key (23505) é absorvido em silêncio — reprocessar não deduz duas vezes", async () => {
      const { db } = fakeDb({
        linkForItem: () => ({ id: "link-1", sku_id: "sku-1" }),
        stockMovementConflict: true,
      });
      const lines: string[] = [];

      await expect(run(db, BASE_ORDER, lines)).resolves.toBeUndefined();
      expect(lines.join()).not.toContain("stock_movement_not_recorded");
    });

    it("uma falha de gravação REAL em stock_movements é logada, mas não derruba a persistência do pedido", async () => {
      const { db, upserted } = fakeDb({
        linkForItem: () => ({ id: "link-1", sku_id: "sku-1" }),
        stockMovementError: true,
      });
      const lines: string[] = [];

      await expect(run(db, BASE_ORDER, lines)).resolves.toBeUndefined();
      expect(lines.join()).toContain("stock_movement_not_recorded");
      expect(upserted.find((entry) => entry.table === "orders")).toBeDefined();
    });
  });

  describe("reversão de estoque por cancelamento (stock_movements)", () => {
    it("pedido cancelado com VENDA_ML gravado: reverte com CANCELAMENTO_ML e quantidade invertida", async () => {
      const { db, inserted } = fakeDb({
        existingSaleMovements: [{ sku_id: "sku-1", qty_delta: -1, idempotency_key: "venda:2032217210:0" }],
      });
      const order: ParsedOrder = { ...BASE_ORDER, status: "cancelled" };

      await run(db, order);

      const movement = inserted.find((entry) => entry.table === "stock_movements")?.rows[0] as {
        sku_id: string;
        location_kind: string;
        qty_delta: number;
        movement_type: string;
        source_type: string;
        source_id: string;
        idempotency_key: string;
      };

      expect(movement).toMatchObject({
        sku_id: "sku-1",
        location_kind: "LOCAL",
        qty_delta: 1,
        movement_type: "CANCELAMENTO_ML",
        source_type: "ORDER",
        source_id: String(BASE_ORDER.id),
        idempotency_key: "cancelamento:venda:2032217210:0",
      });
    });

    it("pending_cancel também reverte — mesma semântica de 'cancelamento que já vale' do motor de diff", async () => {
      const { db, inserted } = fakeDb({
        existingSaleMovements: [{ sku_id: "sku-1", qty_delta: -1, idempotency_key: "venda:2032217210:0" }],
      });
      const order: ParsedOrder = { ...BASE_ORDER, status: "pending_cancel" };

      await run(db, order);

      const movement = inserted.find((entry) => entry.table === "stock_movements")?.rows[0] as {
        movement_type: string;
      };
      expect(movement.movement_type).toBe("CANCELAMENTO_ML");
    });

    it("KIT: reverte um movimento por componente, na mesma forma gravada pela venda", async () => {
      const { db, inserted } = fakeDb({
        existingSaleMovements: [
          { sku_id: "sku-lampada", qty_delta: -6, idempotency_key: "venda:2032217210:0:sku-lampada" },
          { sku_id: "sku-suporte", qty_delta: -3, idempotency_key: "venda:2032217210:0:sku-suporte" },
        ],
      });
      const order: ParsedOrder = { ...BASE_ORDER, status: "cancelled" };

      await run(db, order);

      const movements = inserted
        .filter((entry) => entry.table === "stock_movements")
        .map((entry) => entry.rows[0]) as { sku_id: string; qty_delta: number }[];

      expect(movements).toEqual([
        expect.objectContaining({ sku_id: "sku-lampada", qty_delta: 6 }),
        expect.objectContaining({ sku_id: "sku-suporte", qty_delta: 3 }),
      ]);
    });

    it("nenhum VENDA_ML gravado (item nunca vinculado): nada a reverter", async () => {
      const { db, inserted } = fakeDb();
      const order: ParsedOrder = { ...BASE_ORDER, status: "cancelled" };

      await run(db, order);

      expect(inserted.find((entry) => entry.table === "stock_movements")).toBeUndefined();
    });

    it("pedido cancelado NÃO recalcula dedução a partir dos itens atuais — só reversão, nunca VENDA_ML", async () => {
      const { db, inserted } = fakeDb({
        linkForItem: () => ({ id: "link-1", sku_id: "sku-1" }),
        existingSaleMovements: [{ sku_id: "sku-1", qty_delta: -1, idempotency_key: "venda:2032217210:0" }],
      });
      const order: ParsedOrder = { ...BASE_ORDER, status: "cancelled" };

      await run(db, order);

      const movementTypes = inserted
        .filter((entry) => entry.table === "stock_movements")
        .map((entry) => (entry.rows[0] as { movement_type: string }).movement_type);

      expect(movementTypes).toEqual(["CANCELAMENTO_ML"]);
    });

    it("conflito de idempotency_key (23505) na reversão é absorvido em silêncio — reprocessar não reverte duas vezes", async () => {
      const { db } = fakeDb({
        existingSaleMovements: [{ sku_id: "sku-1", qty_delta: -1, idempotency_key: "venda:2032217210:0" }],
        stockMovementConflict: true,
      });
      const order: ParsedOrder = { ...BASE_ORDER, status: "cancelled" };
      const lines: string[] = [];

      await expect(run(db, order, lines)).resolves.toBeUndefined();
      expect(lines.join()).not.toContain("stock_movement_not_recorded");
    });

    it("uma falha de gravação REAL na reversão é logada, mas não derruba a persistência do pedido", async () => {
      const { db, upserted } = fakeDb({
        existingSaleMovements: [{ sku_id: "sku-1", qty_delta: -1, idempotency_key: "venda:2032217210:0" }],
        stockMovementError: true,
      });
      const order: ParsedOrder = { ...BASE_ORDER, status: "cancelled" };
      const lines: string[] = [];

      await expect(run(db, order, lines)).resolves.toBeUndefined();
      expect(lines.join()).toContain("stock_movement_not_recorded");
      expect(upserted.find((entry) => entry.table === "orders")).toBeDefined();
    });
  });

  describe("falha de LEITURA não é engolida em silêncio — sempre rejeita, nunca segue com dado incompleto", () => {
    it("falha ao ler o status anterior da order rejeita, em vez de tratar como order nova", async () => {
      const { db } = fakeDb({ previousStatusError: true });

      await expect(run(db, BASE_ORDER)).rejects.toThrow(/status anterior/);
    });

    it("falha ao ler stock_movements existentes numa reversão rejeita, em vez de reverter zero movimentos", async () => {
      const { db } = fakeDb({ saleMovementsError: true });
      const order: ParsedOrder = { ...BASE_ORDER, status: "cancelled" };

      await expect(run(db, order)).rejects.toThrow(/stock_movements/);
    });

    it("falha ao resolver sku_listing_links rejeita, em vez de gravar o item sem SKU (puparia a dedução)", async () => {
      const { db } = fakeDb({ linkLookupError: true });

      await expect(run(db, BASE_ORDER)).rejects.toThrow(/sku_listing_link/);
    });

    it("falha ao ler o kind do SKU rejeita, em vez de tratar um KIT real como PRODUTO sem componentes", async () => {
      const { db } = fakeDb({ linkForItem: () => ({ id: "link-1", sku_id: "sku-1" }), skuKindError: true });

      await expect(run(db, BASE_ORDER)).rejects.toThrow(/kind do sku/);
    });

    it("falha ao ler os componentes de um KIT rejeita, em vez de deduzir sem componente nenhum", async () => {
      const { db } = fakeDb({
        linkForItem: () => ({ id: "link-kit", sku_id: "sku-kit" }),
        skuKindById: () => "KIT",
        componentsError: true,
      });

      await expect(run(db, BASE_ORDER)).rejects.toThrow(/componentes do kit/);
    });
  });
});
