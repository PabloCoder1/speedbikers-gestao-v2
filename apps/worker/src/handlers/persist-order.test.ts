import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { ParsedOrder } from "./order-schema.js";
import type { OrderPrefetch, PersistOrderContext, ResolvedLink } from "./persist-order.js";
import { persistOrder, prefetchOrders } from "./persist-order.js";

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
  /**
   * Simula o vínculo voltando SEM o SKU embutido (D-188) — o estado que a FK
   * torna impossível e que, se tratado como PRODUTO, deduziria contra a linha
   * de um KIT.
   */
  linkWithoutSku?: boolean;
  /** Simula falha no `upsert` de `orders` — a escrita mais critica do handler (D-178). */
  orderWriteError?: boolean;
  /** Simula falha no `delete` de `order_items` (D-178). */
  itemsDeleteError?: boolean;
  /** Simula falha no `insert` de `order_items` (D-178). */
  itemsInsertError?: boolean;
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

        if (table === "orders" && options.orderWriteError === true) {
          return Promise.resolve({ data: null, error: { code: "42P01", message: "boom" } });
        }

        return Promise.resolve({ data: null, error: null });
      },
      delete: () => ({
        eq: (col: string, val: unknown) => {
          deleted.push({ table, filters: { [col]: val } });

          if (table === "order_items" && options.itemsDeleteError === true) {
            return Promise.resolve({ data: null, error: { code: "42P01", message: "boom" } });
          }

          return Promise.resolve({ data: null, error: null });
        },
      }),
      insert: (row: unknown) => {
        if (table === "order_items" && options.itemsInsertError === true) {
          inserted.push({ table, rows: Array.isArray(row) ? row : [row] });

          return Promise.resolve({ data: null, error: { code: "42P01", message: "boom" } });
        }

        return writeAppendOnly(table, row);
      },
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

        // D-188: `skus` e `sku_components` deixaram de ser consultadas — vêm
        // embutidas na leitura do vínculo. As opções `skuKindById` e
        // `componentsByKitId` continuam existindo e significando o mesmo; é o
        // ramo do vínculo, abaixo, que as monta na forma do embed.

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

          if (link === null) {
            return { data: null, error: null };
          }

          // D-188: o vínculo passou a trazer `kind` e componentes embutidos.
          // O fake MONTA essa forma a partir das mesmas opções de antes —
          // `skuKindById` e `componentsByKitId` continuam significando o
          // mesmo, e os testes que as usam não mudaram.
          //
          // O que este fake NÃO valida é a string de projeção (`select: () =>
          // self`): a forma do embed é provada contra o PostgREST real em
          // `packages/db/src/projections.integration.test.ts`.
          if (options.linkWithoutSku === true) {
            return { data: { ...link, item_id: itemId, variation_id: variationId, skus: null }, error: null };
          }

          const kind = options.skuKindById?.(link.sku_id) ?? "PRODUTO";

          return {
            data: {
              ...link,
              item_id: itemId,
              variation_id: variationId,
              skus: {
                kind,
                sku_components: kind === "KIT" ? (options.componentsByKitId?.(link.sku_id) ?? []) : [],
              },
            },
            error: null,
          };
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

    // Reescrito em D-187. A intenção original — separar o 23505 (absorvido)
    // de uma falha REAL (não absorvida) — é a mesma; o que mudou é o que
    // "não absorvida" significa.
    //
    // Até D-186 este teste exigia log-e-segue, porque D-178 classificara
    // `stock_movements` como observabilidade. A fronteira estava errada: uma
    // linha ali é o que MOVE O SALDO, e a perda era invisível — o trigger
    // `apply_to_balance` não dispara para uma linha que não entrou, então
    // `verify-ledger-integrity` compara dois lados que concordam em estar
    // sem ela.
    it("uma falha de gravação REAL em stock_movements ABORTA — não é telemetria, é o saldo (D-187)", async () => {
      const { db } = fakeDb({
        linkForItem: () => ({ id: "link-1", sku_id: "sku-1" }),
        stockMovementError: true,
      });

      await expect(run(db, BASE_ORDER)).rejects.toThrow(/stock_movements.*VENDA_ML/);
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

    // Reescrito em D-187, mesmo raciocínio do irmão acima. Uma reversão de
    // cancelamento perdida é pior ainda: o estoque fica deduzido por uma
    // venda que não existe mais.
    it("uma falha de gravação REAL na reversão ABORTA (D-187)", async () => {
      const { db } = fakeDb({
        existingSaleMovements: [{ sku_id: "sku-1", qty_delta: -1, idempotency_key: "venda:2032217210:0" }],
        stockMovementError: true,
      });
      const order: ParsedOrder = { ...BASE_ORDER, status: "cancelled" };

      await expect(run(db, order)).rejects.toThrow(/stock_movements.*CANCELAMENTO_ML/);
    });

    // A metade que NÃO mudou, e que precisa continuar valendo: o job é
    // retentado pelo Cloud Tasks, então abortar só é seguro porque repetir é
    // inócuo. Este teste é o que garante que o 23505 continua absorvido.
    it("abortar não quebrou a idempotência: 23505 segue absorvido em silêncio (D-187)", async () => {
      const { db } = fakeDb({
        linkForItem: () => ({ id: "link-1", sku_id: "sku-1" }),
        stockMovementConflict: true,
      });
      const lines: string[] = [];

      await expect(run(db, BASE_ORDER, lines)).resolves.toBeUndefined();
      expect(lines.join()).not.toContain("stock_movement");
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

    // D-184 — a garantia que a rejeição sozinha NÃO dava.
    //
    // `resolveSku` rodava ENTRE o `order_items.delete` e o
    // `order_items.insert`. Rejeitar ali já era o certo, mas tarde demais: o
    // delete já tinha acontecido e o pedido ficava com ZERO itens até um
    // reprocessamento bem-sucedido. Há 2 pedidos assim no Dev — `paid`, com o
    // movimento de estoque gravado e nenhuma linha em `order_items`.
    //
    // Quem paga é `claim-return.ts`: sem a linha do item ele não acha a
    // `position`, emite `claim_return_order_item_not_found` e pula a reversão
    // da devolução. Fica registrado, mas a reversão não acontece.
    //
    // Este teste falha se alguém mover a resolução de volta para depois de
    // uma escrita.
    it("falha ao resolver o vínculo não apaga os itens que já existiam (D-184)", async () => {
      const { db, deleted, upserted } = fakeDb({ linkLookupError: true });

      await expect(run(db, BASE_ORDER)).rejects.toThrow(/sku_listing_link/);

      // Nem o delete dos itens, nem sequer o upsert da própria order: a
      // leitura agora acontece antes de QUALQUER escrita.
      expect(deleted.filter((row) => row.table === "order_items")).toEqual([]);
      expect(upserted.filter((row) => row.table === "orders")).toEqual([]);
    });

    it("falha ao ler o status anterior também rejeita sem escrever nada (D-184)", async () => {
      // Este JÁ passava antes de D-184 — a leitura de status sempre foi a
      // primeira coisa do handler. Está aqui para que o par não se separe:
      // as duas leituras agora sobem juntas, e a garantia tem de valer para
      // as duas. O irmão acima é o que de fato falhava.
      const { db, deleted, upserted } = fakeDb({ previousStatusError: true });

      await expect(run(db, BASE_ORDER)).rejects.toThrow(/status anterior/);

      expect(deleted.filter((row) => row.table === "order_items")).toEqual([]);
      expect(upserted.filter((row) => row.table === "orders")).toEqual([]);
    });

    // Reescrito em D-188. A intenção é a mesma — um KIT real não pode cair
    // como PRODUTO sem componentes —, mas o modo de falha mudou: `kind` não é
    // mais uma leitura própria que pode falhar, e sim um campo do embed. O
    // estado equivalente é o vínculo voltar sem o SKU embutido.
    it("vínculo sem o SKU embutido rejeita, em vez de tratar um KIT real como PRODUTO (D-188)", async () => {
      const { db } = fakeDb({ linkForItem: () => ({ id: "link-1", sku_id: "sku-1" }), linkWithoutSku: true });

      await expect(run(db, BASE_ORDER)).rejects.toThrow(/sem o SKU embutido/);
    });

    // Reescrito em D-188: a falha que este teste simulava — a leitura dos
    // componentes falhando por conta própria — deixou de existir, porque os
    // componentes vêm no mesmo embed do vínculo. Uma leitura que falha agora
    // cai no teste de `linkLookupError`, e um `skus` nulo no de "sem o SKU
    // embutido".
    //
    // O que sobra e vale um tripwire é a OUTRA metade: um KIT sem componentes
    // cadastrados não produz movimento nenhum — a venda não deduz nada, em
    // silêncio. Não é regressão (era assim antes do embed) e não está vivo:
    // medido no Dev, 138 KITs e ZERO sem componentes. Se um dia aparecer, é
    // aqui que a decisão tem de ser retomada, com o número na mão.
    it("KIT sem componentes cadastrados não deduz nada — tripwire, não aprovação (D-188)", async () => {
      const { db, inserted } = fakeDb({
        linkForItem: () => ({ id: "link-kit", sku_id: "sku-kit" }),
        skuKindById: () => "KIT",
        componentsByKitId: () => [],
      });

      await expect(run(db, BASE_ORDER)).resolves.toBeUndefined();

      expect(inserted.filter((row) => row.table === "stock_movements")).toEqual([]);
    });
  });
});

/**
 * D-178 — escrita critica que falha nao pode deixar o handler seguir.
 *
 * O `AdminClient` nao lanca sozinho: sem checar `.error`, `persistOrder`
 * continuava emitindo evento de status e deduzindo estoque de um pedido que
 * podia nao ter sido gravado. Estes testes provam que o fluxo PARA.
 */
describe("persistOrder — escritas críticas (D-178)", () => {
  it("falha ao gravar a order aborta antes de evento e de estoque", async () => {
    const { db, inserted } = fakeDb({ orderWriteError: true, previousStatus: "confirmed" });

    await expect(
      persistOrder(db, CONTEXT, BASE_ORDER, createLogger({}, { sink: () => undefined })),
    ).rejects.toThrow(/orders\.upsert/);

    // Nada depois da order: nem domain_events (a mudanca confirmed -> paid
    // geraria um), nem order_items, nem stock_movements.
    expect(inserted.map((i) => i.table)).not.toContain("domain_events");
    expect(inserted.map((i) => i.table)).not.toContain("order_items");
    expect(inserted.map((i) => i.table)).not.toContain("stock_movements");
  });

  it("falha ao apagar os itens antigos aborta antes de inserir os novos", async () => {
    const { db, inserted } = fakeDb({ itemsDeleteError: true });

    await expect(
      persistOrder(db, CONTEXT, BASE_ORDER, createLogger({}, { sink: () => undefined })),
    ).rejects.toThrow(/order_items\.delete/);

    // O insert nao pode acontecer: delete que falhou + insert que passa
    // deixaria o pedido com itens de duas versoes.
    expect(inserted.map((i) => i.table)).not.toContain("order_items");
  });

  it("falha ao inserir os itens aborta antes de deduzir estoque", async () => {
    const { db, inserted } = fakeDb({ itemsInsertError: true });

    await expect(
      persistOrder(db, CONTEXT, BASE_ORDER, createLogger({}, { sink: () => undefined })),
    ).rejects.toThrow(/order_items\.insert/);

    expect(inserted.map((i) => i.table)).not.toContain("stock_movements");
  });
});


// D-186 — as leituras da pagina inteira, resolvidas de uma vez.
//
// O que estes testes protegem NAO e a latencia: e a diferenca entre "nao ha
// vinculo" e "a leitura em lote nao trouxe o vinculo". As duas produzem o
// mesmo `null` no mapa, e a segunda faz a deducao de estoque ser pulada em
// silencio — a assinatura exata do defeito que corrompeu o saldo em D-131.
describe("prefetchOrders (D-186)", () => {
  interface RespostaFalsa {
    data: unknown;
    error: { message: string } | null;
  }

  function dbFalso(porTabela: Record<string, RespostaFalsa>) {
    const consultadas: string[] = [];

    const cadeia = (resposta: RespostaFalsa) => {
      const self = {
        select: () => self,
        eq: () => self,
        in: () => self,
        then: <R>(onFulfilled: (value: RespostaFalsa) => R) => Promise.resolve(resposta).then(onFulfilled),
      };

      return self;
    };

    const db = {
      from: (table: string) => {
        consultadas.push(table);

        return cadeia(porTabela[table] ?? { data: [], error: null });
      },
    } as unknown as Parameters<typeof prefetchOrders>[0];

    return { db, consultadas };
  }

  const PEDIDO_A: ParsedOrder = { ...BASE_ORDER, id: 2_000_017_347_483_988 };

  it("resolve vínculo, kind e componentes numa leitura só (D-188)", async () => {
    const { db, consultadas } = dbFalso({
      orders: { data: [{ id: 2_000_017_347_483_988, status: "paid" }], error: null },
      sku_listing_links: {
        data: [
          {
            id: "link-1",
            sku_id: "sku-kit",
            item_id: "MLB1054990648",
            variation_id: null,
            skus: { kind: "KIT", sku_components: [{ component_sku_id: "sku-peca", quantity: 2 }] },
          },
        ],
        error: null,
      },
    });

    const prefetch = await prefetchOrders(db, CONTEXT, [PEDIDO_A]);

    expect(prefetch.linkByItemKey.get("MLB1054990648\u0000")).toEqual({
      id: "link-1",
      sku_id: "sku-kit",
      kind: "KIT",
      components: [{ componentSkuId: "sku-peca", quantity: 2 }],
    });

    // D-188: `skus` e `sku_components` deixaram de ser consultas próprias — o
    // embed as traz junto, e elas eram ENCADEADAS (skus dependia dos
    // vínculos, componentes dependiam dos kinds). A forma do embed é provada
    // contra o PostgREST real em `packages/db/src/projections.integration.test.ts`;
    // este fake não valida a string de projeção, e é justamente por isso que
    // aquele portão existe.
    expect(consultadas).toEqual(["orders", "sku_listing_links"]);
  });

  it("vínculo sem o SKU embutido LANÇA — não cai em PRODUTO (D-188)", async () => {
    // A FK `sku_listing_links_sku_id_fkey` é `not null` + `on delete
    // restrict`: a linha do SKU sempre existe. `skus` nulo aqui só pode ser o
    // embed não tendo resolvido, e cair em PRODUTO gravaria `VENDA_ML` contra
    // a linha de um KIT — sem deduzir os componentes, e com uma chave de
    // idempotência que nunca mais é gerada depois do conserto.
    const { db } = dbFalso({
      sku_listing_links: {
        data: [{ id: "link-1", sku_id: "sku-1", item_id: "MLB1054990648", variation_id: null, skus: null }],
        error: null,
      },
    });

    await expect(prefetchOrders(db, CONTEXT, [PEDIDO_A])).rejects.toThrow(/sem o SKU embutido/);
  });

  it("chaveia o pedido por STRING — `orders.id` é bigint e o mapa mente se os tipos divergirem", async () => {
    const { db } = dbFalso({
      orders: { data: [{ id: 2_000_017_347_483_988, status: "cancelled" }], error: null },
    });

    const prefetch = await prefetchOrders(db, CONTEXT, [PEDIDO_A]);

    // A consulta com o número NÃO acha; a com string acha. É por isso que o
    // mapa é `Map<string, ...>` e o chamador usa `String(order.id)`.
    expect(prefetch.previousStatusById.get(String(PEDIDO_A.id))).toBe("cancelled");
    expect(prefetch.previousStatusById.get(PEDIDO_A.id as unknown as string)).toBeUndefined();
  });

  it("recusa leitura que pode ter sido cortada pelo teto de 1.000 do PostgREST", async () => {
    // D-131: acima do teto, a resposta volta cortada com `error` NULO. Aqui
    // "cortada" seria indistinguível de "sem vínculo" — e um vínculo perdido
    // grava `sku_id` nulo e pula a dedução.
    const muitas = Array.from({ length: 1000 }, (_, i) => ({
      id: `link-${String(i)}`,
      sku_id: "sku-1",
      item_id: `MLB${String(i)}`,
      variation_id: null,
    }));

    const { db } = dbFalso({ sku_listing_links: { data: muitas, error: null } });

    await expect(prefetchOrders(db, CONTEXT, [PEDIDO_A])).rejects.toThrow(/cortada pelo teto|D-131/);
  });

  it("recusa `data` nulo sem erro, em vez de tratar como página sem vínculos", async () => {
    const { db } = dbFalso({ sku_listing_links: { data: null, error: null } });

    await expect(prefetchOrders(db, CONTEXT, [PEDIDO_A])).rejects.toThrow(/data nulo sem erro/);
  });

  it("propaga erro de leitura em vez de virar 'sem vínculo'", async () => {
    const { db } = dbFalso({ sku_listing_links: { data: null, error: { message: "boom" } } });

    await expect(prefetchOrders(db, CONTEXT, [PEDIDO_A])).rejects.toThrow(/sku_listing_links.*boom/);
  });

  // A propriedade pela qual esta fatia existe: o número de idas ao banco não
  // cresce com o número de pedidos da página. Era 3 por pedido — 150 numa
  // página de 50 do Mercado Livre.
  it("o número de leituras NÃO cresce com o tamanho da página", async () => {
    const pagina = [
      { ...BASE_ORDER, id: 1 },
      { ...BASE_ORDER, id: 2 },
      { ...BASE_ORDER, id: 3 },
      { ...BASE_ORDER, id: 4 },
      { ...BASE_ORDER, id: 5 },
    ];

    const { db, consultadas } = dbFalso({
      sku_listing_links: {
        data: [
          {
            id: "link-1",
            sku_id: "sku-1",
            item_id: "MLB1054990648",
            variation_id: null,
            skus: { kind: "PRODUTO", sku_components: [] },
          },
        ],
        error: null,
      },
    });

    await prefetchOrders(db, CONTEXT, pagina);

    expect(consultadas).toEqual(["orders", "sku_listing_links"]);
  });

  it("página vazia não vai ao banco", async () => {
    const { db, consultadas } = dbFalso({});

    const prefetch = await prefetchOrders(db, CONTEXT, []);

    expect(consultadas).toEqual([]);
    expect(prefetch.linkByItemKey.size).toBe(0);
  });
});

describe("persistOrder com prefetch (D-186)", () => {
  function prefetchDe(parcial: Partial<OrderPrefetch>): OrderPrefetch {
    return {
      previousStatusById: parcial.previousStatusById ?? new Map<string, string>(),
      linkByItemKey: parcial.linkByItemKey ?? new Map<string, ResolvedLink>(),
    };
  }

  it("usa o vínculo do lote e grava o sku_id — sem ler sku_listing_links", async () => {
    const { db, inserted } = fakeDb({
      // Se o handler ignorasse o prefetch e lesse por conta própria, este
      // fake devolveria `null` e o item sairia sem SKU. O teste falha nesse
      // caso, que é o ponto.
      linkForItem: () => null,
    });

    await persistOrder(
      db,
      CONTEXT,
      BASE_ORDER,
      createLogger({ service: "test" }),
      prefetchDe({
        linkByItemKey: new Map([
          ["MLB1054990648\u0000", { id: "link-9", sku_id: "sku-9", kind: "PRODUTO" as const, components: [] }],
        ]),
      }),
    );

    const itens = inserted.find((row) => row.table === "order_items");

    expect((itens?.rows[0] as { sku_id: string }).sku_id).toBe("sku-9");
    expect((itens?.rows[0] as { sku_listing_link_id: string }).sku_listing_link_id).toBe("link-9");
  });

  it("KIT decompõe pelos componentes do lote", async () => {
    const { db, inserted } = fakeDb({});

    await persistOrder(
      db,
      CONTEXT,
      BASE_ORDER,
      createLogger({ service: "test" }),
      prefetchDe({
        linkByItemKey: new Map([
          [
            "MLB1054990648\u0000",
            {
              id: "link-9",
              sku_id: "sku-kit",
              kind: "KIT" as const,
              components: [{ componentSkuId: "sku-peca", quantity: 3 }],
            },
          ],
        ]),
      }),
    );

    const movimentos = inserted.filter((row) => row.table === "stock_movements").flatMap((row) => row.rows);

    // Kit não tem saldo próprio: a dedução vai para o componente.
    expect(movimentos).toHaveLength(1);
    expect((movimentos[0] as { sku_id: string }).sku_id).toBe("sku-peca");
  });
});
