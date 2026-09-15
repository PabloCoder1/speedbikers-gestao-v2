import type { ErpCutoff, ObservedSaleTransition } from "@sb/domain";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { ParsedOrder } from "./order-schema.js";
import { novaPagina } from "./page-writes.js";
import type { OrderPrefetch, PersistOrderContext, RecordedOrderMovements, ResolvedLink } from "./persist-order.js";
import { persistOrder, prefetchOrders } from "./persist-order.js";

const CONTEXT: PersistOrderContext = {
  organizationId: "11111111-0000-4000-8000-000000000001",
  mlAccountId: "aaaaaaaa-0000-4000-8000-000000000001",
  eventSource: "sync",
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

/** `BASE_ORDER.date_closed` em UTC — a "venda em" de D-351. */
const VENDA_EM = "2019-05-22T07:51:07.000Z";

/** O corte da planilha de produção: `Lista_de_Estoque_0914184200.xlsx`. */
const CORTE = "2026-09-14T18:42:00.000Z";

/** Quando essa planilha chegou à V3: o primeiro `created_at` dos snapshots de produção. */
const IMPORTADO_EM = "2026-09-14T18:44:18.714Z";

/** `created_at` padrão de um movimento já gravado nos testes: depois do import. */
const GRAVADO_EM = "2026-09-14T19:00:00.000Z";

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
  in: (col: string, val: unknown) => ReturnType<typeof filterChain>;
  is: (col: string, val: unknown) => ReturnType<typeof filterChain>;
  select: () => ReturnType<typeof filterChain>;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  then: <T>(
    onFulfilled: (value: { data: unknown; error: unknown }) => T,
  ) => Promise<T>;
} {
  const self = {
    eq: (col: string, val: unknown) => filterChain({ ...filters, [col]: val }, resolve),
    in: (col: string, val: unknown) => filterChain({ ...filters, [col]: val }, resolve),
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
  /**
   * Movimentos já gravados para a order. `movement_type` padrão `VENDA_ML` e
   * `occurred_at` padrão a venda em; `ESTORNO_PRE_CAPTURA` marca a venda como
   * estornada (D-351).
   */
  existingSaleMovements?: {
    sku_id: string;
    qty_delta: number;
    idempotency_key: string;
    movement_type?: string;
    occurred_at?: string;
    /** `stock_movements.created_at` — padrão, depois do import (a venda seria estornada). */
    created_at?: string;
  }[];
  /** Simula falha (não conflito) ao ler o status anterior da order. */
  previousStatusError?: boolean;
  /** Simula falha ao ler stock_movements existentes. */
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
  /**
   * `sku_id` -> `captured_at` que `get_erp_stock_cutoffs` devolve (D-351). SKU
   * ausente sai com corte nulo — a organização sem snapshot, comportamento de
   * antes da guarda.
   */
  cutoffs?: Record<string, string | null>;
  /** Linhas cruas da RPC, no lugar da resposta montada por `cutoffs`. */
  cutoffRows?: unknown[];
  /** Simula falha da RPC do corte. */
  cutoffError?: boolean;
  /** `imported_at` que a RPC devolve para todo corte não nulo — padrão, o import de produção. */
  cutoffImportedAt?: string;
  /** `reconciled_at` que a RPC devolve para todo corte não nulo — padrão, nunca reconciliou. */
  cutoffReconciledAt?: string | null;
  /**
   * `exported_at` que a RPC devolve para todo corte não nulo — padrão, o próprio
   * `captured_at` (o snapshot já corrigido para a exportação).
   */
  cutoffExportedAt?: string;
  /**
   * `DEVOLUCAO_ML` gravadas que `get_order_return_movements` devolve
   * (verificação de e6fda07, ALTA-1). `order_id` padrão, o pedido perguntado.
   */
  recordedReturns?: { order_id?: string; sku_id: string; qty_delta: number; idempotency_key: string }[];
  /** Simula falha da leitura das devoluções gravadas. */
  returnsReadError?: boolean;
  /**
   * `order.cancelled` já gravados para o pedido (D-351): a transição de venda
   * para cancelado que sobrevive ao retry.
   */
  cancelledEvents?: { before: unknown; occurred_at: string }[];
  /** Simula falha na leitura de `domain_events`. */
  eventsReadError?: boolean;
}

function fakeDb(options: FakeDbOptions = {}): {
  db: Parameters<typeof persistOrder>[0];
  upserted: { table: string; row: unknown }[];
  deleted: { table: string; filters: Record<string, unknown> }[];
  inserted: { table: string; rows: unknown[] }[];
  rpcCalls: { fn: string; args: Record<string, unknown> }[];
} {
  const upserted: { table: string; row: unknown }[] = [];
  const deleted: { table: string; filters: Record<string, unknown> }[] = [];
  const inserted: { table: string; rows: unknown[] }[] = [];
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

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
    // D-351: `get_erp_stock_cutoffs`; e, desde a verificação de e6fda07,
    // `get_order_return_movements` (as devoluções gravadas dos pedidos).
    rpc: (fn: string, args: { p_organization_id: string; p_sku_ids: string[]; p_order_ids: string[] }) => {
      rpcCalls.push({ fn, args });

      if (fn === "get_order_return_movements") {
        if (options.returnsReadError === true) {
          return Promise.resolve({ data: null, error: { code: "42P01", message: "boom" } });
        }

        return Promise.resolve({
          data: (options.recordedReturns ?? []).map((row) => ({ order_id: args.p_order_ids[0], ...row })),
          error: null,
        });
      }

      if (options.cutoffError === true) {
        return Promise.resolve({ data: null, error: { code: "42P01", message: "boom" } });
      }

      if (options.cutoffRows !== undefined) {
        return Promise.resolve({ data: options.cutoffRows, error: null });
      }

      return Promise.resolve({
        data: args.p_sku_ids.map((skuId) => {
          const capturedAt = options.cutoffs?.[skuId] ?? null;

          return {
            sku_id: skuId,
            captured_at: capturedAt,
            imported_at: capturedAt === null ? null : (options.cutoffImportedAt ?? IMPORTADO_EM),
            reconciled_at: capturedAt === null ? null : (options.cutoffReconciledAt ?? null),
            exported_at: capturedAt === null ? null : (options.cutoffExportedAt ?? capturedAt),
          };
        }),
        error: null,
      });
    },
    from: (table: string) => ({
      upsert: (row: unknown) => {
        // `domain_events` e `stock_movements` passaram a gravar por upsert
        // (ON CONFLICT DO NOTHING, D-092) em vez de INSERT com o 23505
        // absorvido no cliente. Continuam sendo contabilizados em `inserted`:
        // o que os testes verificam é O QUE foi gravado, não o verbo.
        if (table === "domain_events" || table === "stock_movements") {
          return writeAppendOnly(table, row);
        }

        // D-189: `order_items` passou a gravar por upsert (grava e depois
        // apaga a cauda, em vez de apagar e depois gravar). Segue contando
        // em `inserted` pelo mesmo motivo já registrado para `domain_events`
        // e `stock_movements`: o que os testes verificam é O QUE foi
        // gravado, não o verbo.
        if (table === "order_items") {
          inserted.push({ table, rows: Array.isArray(row) ? row : [row] });

          return Promise.resolve(
            options.itemsInsertError === true
              ? { data: null, error: { code: "42P01", message: "boom" } }
              : { data: null, error: null },
          );
        }

        upserted.push({ table, row });

        if (table === "orders" && options.orderWriteError === true) {
          return Promise.resolve({ data: null, error: { code: "42P01", message: "boom" } });
        }

        return Promise.resolve({ data: null, error: null });
      },
      delete: () => {
        // D-189: a exclusão da cauda é `.eq("order_id").gte("position", n)`.
        // A cadeia precisa ser thenable em qualquer ponto: `claim-return` e
        // outros ainda usam só `.eq()`.
        const resultado = () =>
          Promise.resolve(
            table === "order_items" && options.itemsDeleteError === true
              ? { data: null, error: { code: "42P01", message: "boom" } }
              : { data: null, error: null },
          );

        const cadeia = (filters: Record<string, unknown>) => {
          const self = {
            eq: (col: string, val: unknown) => cadeia({ ...filters, [col]: val }),
            gte: (col: string, val: unknown) => cadeia({ ...filters, [`${col}>=`]: val }),
            then: <T>(onFulfilled: (value: { data: null; error: unknown }) => T) => {
              deleted.push({ table, filters });

              return resultado().then(onFulfilled);
            },
          };

          return self;
        };

        return cadeia({});
      },
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

        // D-351: a transição de venda para cancelado já gravada.
        if (table === "domain_events") {
          return filterChain({}, (filters) => {
            if (options.eventsReadError === true) {
              return { data: null, error: { code: "42P01", message: "boom" } };
            }

            const pedido = Array.isArray(filters.entity_id) ? String(filters.entity_id[0]) : String(BASE_ORDER.id);

            return {
              data: (options.cancelledEvents ?? []).map((row) => ({ entity_id: pedido, ...row })),
              error: null,
            };
          });
        }

        if (table === "stock_movements") {
          return filterChain({}, (filters) => {
            if (options.saleMovementsError === true) {
              return { data: null, error: { code: "42P01", message: "boom" } };
            }

            // D-351: a leitura é por lote de pedidos (`.in("source_id", [...])`)
            // e traz venda e estorno juntos.
            const pedido = Array.isArray(filters.source_id) ? String(filters.source_id[0]) : String(BASE_ORDER.id);

            // O filtro de tipo é respeitado: uma leitura que deixasse de pedir
            // `CANCELAMENTO_ML` (verificação de e6fda07) não pode passar pelo fake.
            const tipos = Array.isArray(filters.movement_type) ? (filters.movement_type as string[]) : null;

            return {
              data: (options.existingSaleMovements ?? [])
                .map((row) => ({
                  source_id: pedido,
                  movement_type: "VENDA_ML",
                  occurred_at: VENDA_EM,
                  created_at: GRAVADO_EM,
                  ...row,
                }))
                .filter((row) => tipos === null || tipos.includes(row.movement_type)),
              error: null,
            };
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

  return { db, upserted, deleted, inserted, rpcCalls };
}

function run(db: Parameters<typeof persistOrder>[0], order: ParsedOrder, lines: string[] = []) {
  return persistOrder(db, CONTEXT, order, createLogger({}, { sink: (line) => lines.push(line) }));
}

interface MovimentoGravado {
  sku_id: string;
  qty_delta: number;
  movement_type: string;
  source_type: string;
  source_id: string;
  idempotency_key: string;
  occurred_at: string;
}

function movimentos(inserted: { table: string; rows: unknown[] }[]): MovimentoGravado[] {
  return inserted.filter((entry) => entry.table === "stock_movements").flatMap((entry) => entry.rows) as MovimentoGravado[];
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

  // Reescrito em D-189. A intenção — reprocessar substitui os itens, sem
  // sobra de uma versão anterior — é a mesma. A ORDEM é que se inverteu:
  // grava primeiro, apaga a cauda depois, para que não exista instante em
  // que o pedido esteja sem itens.
  it("reprocessar substitui os itens: grava e SÓ ENTÃO apaga a cauda (D-189)", async () => {
    const { db, deleted, inserted } = fakeDb();

    await run(db, BASE_ORDER);

    expect(inserted.find((entry) => entry.table === "order_items")).toBeDefined();

    // A cauda é tudo a partir da posição que o pedido atual não ocupa.
    expect(deleted).toEqual([
      { table: "order_items", filters: { order_id: BASE_ORDER.id, "position>=": 1 } },
    ]);
  });

  // Contrato NOVO em D-189, e a mudança é deliberada.
  //
  // Antes: um pedido com `order_items: []` fazia o handler APAGAR os itens
  // existentes e sair. Isso destrói dado a partir de uma resposta vazia do
  // Mercado Livre — e uma order não perde itens: eles são fixados na compra.
  // Uma resposta sem itens é anomalia da API, não fato do negócio.
  //
  // Isso importa porque é um dos dois caminhos que produzem o estado dos 2
  // pedidos quebrados no Dev (`paid`, com movimento de estoque e ZERO itens).
  // O outro era a janela entre `delete` e `insert`. Esta fatia fecha os dois;
  // qual dos dois aconteceu não dá para saber com o que está gravado.
  it("pedido sem itens NÃO apaga os que já existem — resposta vazia não é fato (D-189)", async () => {
    const { db, deleted, inserted } = fakeDb();
    const order: ParsedOrder = { ...BASE_ORDER, order_items: [] };

    await run(db, order);

    expect(deleted).toEqual([]);
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
        source: string;
      };
      expect(event).toMatchObject({
        event_type: "order.cancelled",
        entity_id: String(BASE_ORDER.id),
        before: { status: "paid" },
        after: { status: "cancelled" },
        dedup_key: `order.cancelled:${String(BASE_ORDER.id)}:cancelled`,
        source: "sync",
      });
    });

    // D-351: a carga da história grava o evento com fonte `backfill`, que o
    // `fan_out_notification` não transforma em notificação.
    it("a fonte do evento vem do contexto: backfill sai backfill", async () => {
      const { db, inserted } = fakeDb({ previousStatus: null });
      const order: ParsedOrder = { ...BASE_ORDER, status: "cancelled" };

      await persistOrder(db, { ...CONTEXT, eventSource: "backfill" }, order, createLogger({}, { sink: () => undefined }));

      const event = inserted.find((entry) => entry.table === "domain_events")?.rows[0] as { source: string };
      expect(event.source).toBe("backfill");
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
 * D-351 — venda anterior ao snapshot do UpSeller.
 *
 * Em produção, pedidos antigos atualizados depois da planilha geravam o
 * primeiro `VENDA_ML` deles, com `occurred_at` = a data da atualização: o saldo
 * contava a venda duas vezes e ela entrava no alvo da reconciliação. Estes
 * testes são o caminho do webhook (sem prefetch); o do lote está no fim do
 * arquivo.
 */
describe("persistOrder — venda anterior ao snapshot do ERP (D-351)", () => {
  const COM_VINCULO = { linkForItem: () => ({ id: "link-1", sku_id: "sku-1" }) };

  it("pedido antigo pago: grava o VENDA_ML com occurred_at = date_closed E o ESTORNO_PRE_CAPTURA com a MESMA data", async () => {
    const { db, inserted } = fakeDb({ ...COM_VINCULO, cutoffs: { "sku-1": CORTE } });

    await run(db, BASE_ORDER);

    expect(movimentos(inserted)).toEqual([
      {
        organization_id: CONTEXT.organizationId,
        sku_id: "sku-1",
        location_kind: "LOCAL",
        qty_delta: -1,
        movement_type: "VENDA_ML",
        source_type: "ORDER",
        source_id: String(BASE_ORDER.id),
        idempotency_key: `venda:${String(BASE_ORDER.id)}:0`,
        occurred_at: VENDA_EM,
      },
      {
        // Linha de sistema: sem `created_by` (nulo no banco).
        organization_id: CONTEXT.organizationId,
        sku_id: "sku-1",
        location_kind: "LOCAL",
        qty_delta: 1,
        movement_type: "ESTORNO_PRE_CAPTURA",
        source_type: "ORDER",
        source_id: String(BASE_ORDER.id),
        idempotency_key: `estorno:venda:${String(BASE_ORDER.id)}:0`,
        occurred_at: VENDA_EM,
      },
    ]);
  });

  it("venda em IGUAL ao corte estorna; corte 1 ms antes da venda não estorna", async () => {
    const igual = fakeDb({ ...COM_VINCULO, cutoffs: { "sku-1": VENDA_EM } });
    await run(igual.db, BASE_ORDER);
    expect(movimentos(igual.inserted).map((m) => m.movement_type)).toEqual(["VENDA_ML", "ESTORNO_PRE_CAPTURA"]);

    const antes = fakeDb({ ...COM_VINCULO, cutoffs: { "sku-1": "2019-05-22T07:51:06.999Z" } });
    await run(antes.db, BASE_ORDER);
    expect(movimentos(antes.inserted).map((m) => m.movement_type)).toEqual(["VENDA_ML"]);
  });

  it("occurred_at da venda é date_closed, nunca date_last_updated — e sem date_closed, date_created", async () => {
    const fechado = fakeDb(COM_VINCULO);
    await run(fechado.db, BASE_ORDER);
    expect(movimentos(fechado.inserted)[0]?.occurred_at).toBe(VENDA_EM);

    const semFechamento = fakeDb(COM_VINCULO);
    await run(semFechamento.db, { ...BASE_ORDER, date_closed: null });
    expect(movimentos(semFechamento.inserted)[0]?.occurred_at).toBe("2019-05-22T07:51:05.000Z");
  });

  it("KIT com um componente de cada lado do corte: estorna só o componente cujo corte é posterior à venda", async () => {
    const { db, inserted } = fakeDb({
      linkForItem: () => ({ id: "link-kit", sku_id: "sku-kit" }),
      skuKindById: () => "KIT",
      componentsByKitId: () => [
        { component_sku_id: "sku-lampada", quantity: 2 },
        { component_sku_id: "sku-suporte", quantity: 1 },
      ],
      cutoffs: { "sku-lampada": CORTE, "sku-suporte": "2019-01-01T00:00:00.000Z" },
    });

    await run(db, BASE_ORDER);

    expect(movimentos(inserted).map((m) => [m.movement_type, m.sku_id])).toEqual([
      ["VENDA_ML", "sku-lampada"],
      ["VENDA_ML", "sku-suporte"],
      ["ESTORNO_PRE_CAPTURA", "sku-lampada"],
    ]);
  });

  it("organização sem snapshot (corte nulo): grava a venda e não estorna — o comportamento de antes", async () => {
    const { db, inserted, rpcCalls } = fakeDb(COM_VINCULO);

    await run(db, BASE_ORDER);

    expect(rpcCalls).toHaveLength(1);
    expect(movimentos(inserted).map((m) => m.movement_type)).toEqual(["VENDA_ML"]);
  });

  it("o webhook lê o corte UMA vez, com todos os SKUs que vai movimentar — os componentes, não o kit", async () => {
    // O corte de cada SKU, e o da organização para quem não tem snapshot
    // próprio, é resolvido NA RPC (provado na integração). O worker manda
    // todos os ids e usa a linha de cada um.
    const { db, rpcCalls } = fakeDb({
      linkForItem: () => ({ id: "link-kit", sku_id: "sku-kit" }),
      skuKindById: () => "KIT",
      componentsByKitId: () => [
        { component_sku_id: "sku-suporte", quantity: 1 },
        { component_sku_id: "sku-lampada", quantity: 2 },
      ],
    });

    await run(db, BASE_ORDER);

    expect(rpcCalls).toEqual([
      {
        fn: "get_erp_stock_cutoffs",
        args: { p_organization_id: CONTEXT.organizationId, p_sku_ids: ["sku-lampada", "sku-suporte"] },
      },
    ]);
  });

  it("falha da leitura do corte LANÇA antes de qualquer escrita — nunca vira 'sem corte'", async () => {
    const { db, inserted, upserted } = fakeDb({ ...COM_VINCULO, cutoffError: true });

    await expect(run(db, BASE_ORDER)).rejects.toThrow(/get_erp_stock_cutoffs.*boom/);

    expect(upserted).toEqual([]);
    expect(inserted).toEqual([]);
  });

  it("resposta sem a linha de um SKU pedido LANÇA — leitura incompleta não vira 'sem corte'", async () => {
    const { db, inserted } = fakeDb({ ...COM_VINCULO, cutoffRows: [] });

    await expect(run(db, BASE_ORDER)).rejects.toThrow(/nao devolveu o corte do SKU sku-1/);
    expect(inserted).toEqual([]);
  });

  it("resposta com 1.000 linhas LANÇA — pode ter sido cortada pelo teto do PostgREST", async () => {
    const muitas = Array.from({ length: 1000 }, (_, i) => ({ sku_id: `sku-${String(i)}`, captured_at: CORTE }));
    const { db } = fakeDb({ ...COM_VINCULO, cutoffRows: muitas });

    await expect(run(db, BASE_ORDER)).rejects.toThrow(/teto do PostgREST/);
  });

  it("VENDA_ML já gravado pelo worker antigo: o estorno espelha a linha gravada — SKU, quantidade e data", async () => {
    const { db, inserted } = fakeDb({
      ...COM_VINCULO,
      existingSaleMovements: [
        {
          sku_id: "sku-antigo",
          qty_delta: -1,
          idempotency_key: `venda:${String(BASE_ORDER.id)}:0`,
          occurred_at: "2026-09-14T19:03:00.000Z",
        },
      ],
      cutoffs: { "sku-1": CORTE, "sku-antigo": CORTE },
    });

    await run(db, BASE_ORDER);

    expect(movimentos(inserted).find((m) => m.movement_type === "ESTORNO_PRE_CAPTURA")).toMatchObject({
      sku_id: "sku-antigo",
      qty_delta: 1,
      occurred_at: "2026-09-14T19:03:00.000Z",
    });
  });

  describe("cancelamento de venda estornada", () => {
    const VENDA_ESTORNADA = [
      { sku_id: "sku-1", qty_delta: -1, idempotency_key: `venda:${String(BASE_ORDER.id)}:0` },
      {
        sku_id: "sku-1",
        qty_delta: 1,
        idempotency_key: `estorno:venda:${String(BASE_ORDER.id)}:0`,
        movement_type: "ESTORNO_PRE_CAPTURA",
      },
    ];

    it("cancelada DEPOIS do corte: reverte — o UpSeller devolveu a unidade depois da planilha", async () => {
      const { db, inserted } = fakeDb({ existingSaleMovements: VENDA_ESTORNADA, cutoffs: { "sku-1": CORTE } });

      await run(db, { ...BASE_ORDER, status: "cancelled", date_last_updated: "2026-09-14T19:07:45.000Z" });

      expect(movimentos(inserted)).toEqual([
        expect.objectContaining({ movement_type: "CANCELAMENTO_ML", qty_delta: 1, occurred_at: "2026-09-14T19:07:45.000Z" }),
      ]);
    });

    it("cancelada ATÉ o corte: não reverte — a planilha já tinha a unidade de volta", async () => {
      const { db, inserted } = fakeDb({ existingSaleMovements: VENDA_ESTORNADA, cutoffs: { "sku-1": CORTE } });
      const lines: string[] = [];

      await run(db, { ...BASE_ORDER, status: "cancelled", date_last_updated: CORTE }, lines);

      expect(movimentos(inserted)).toEqual([]);
      expect(lines.join()).toContain("cancellation_reversal_pulada_pre_captura");
    });

    it("sem date_last_updated nem last_updated (instante desconhecido): reverte e avisa", async () => {
      const { db, inserted } = fakeDb({ existingSaleMovements: VENDA_ESTORNADA, cutoffs: { "sku-1": CORTE } });
      const lines: string[] = [];

      await run(db, { ...BASE_ORDER, status: "cancelled", date_last_updated: undefined, last_updated: undefined }, lines);

      expect(movimentos(inserted).map((m) => m.movement_type)).toEqual(["CANCELAMENTO_ML"]);
      expect(lines.join()).toContain("cancellation_reversal_sem_instante_do_cancelamento");
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

  // Reescrito em D-189: a exclusão passou a ser a da CAUDA e roda por último.
  // A intenção continua sendo "falhou, para" — o que mudou é o que já estava
  // gravado quando ela falha, e agora é o estado CERTO.
  it("falha ao apagar a cauda aborta antes de deduzir estoque (D-189)", async () => {
    const { db, inserted } = fakeDb({ itemsDeleteError: true });

    await expect(
      persistOrder(db, CONTEXT, BASE_ORDER, createLogger({}, { sink: () => undefined })),
    ).rejects.toThrow(/order_items\.delete da cauda/);

    // Os itens JÁ foram gravados — e é isso que torna esta falha inofensiva
    // perto da antiga: o pedido fica com os itens certos, não com zero.
    expect(inserted.map((i) => i.table)).toContain("order_items");
    expect(inserted.map((i) => i.table)).not.toContain("stock_movements");
  });

  it("falha ao gravar os itens aborta antes de deduzir estoque", async () => {
    const { db, inserted } = fakeDb({ itemsInsertError: true });

    await expect(
      persistOrder(db, CONTEXT, BASE_ORDER, createLogger({}, { sink: () => undefined })),
    ).rejects.toThrow(/order_items\.upsert/);

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

  function dbFalso(
    porTabela: Record<string, RespostaFalsa>,
    // D-351: por padrão, organização sem snapshot — uma linha nula por id.
    corte: (ids: string[]) => RespostaFalsa = (ids) => ({
      data: ids.map((id) => ({ sku_id: id, captured_at: null })),
      error: null,
    }),
  ) {
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
      rpc: (fn: string, args: { p_sku_ids: string[] }) => {
        consultadas.push(`rpc:${fn}`);

        if (fn === "get_order_return_movements") {
          return Promise.resolve(porTabela["rpc:get_order_return_movements"] ?? { data: [], error: null });
        }

        return Promise.resolve(corte(args.p_sku_ids));
      },
    } as unknown as Parameters<typeof prefetchOrders>[0];

    return { db, consultadas };
  }

  const PEDIDO_A: ParsedOrder = { ...BASE_ORDER, id: 2_000_017_347_483_988 };

  const LINK_PRODUTO = {
    id: "link-1",
    sku_id: "sku-1",
    item_id: "MLB1054990648",
    variation_id: null,
    skus: { kind: "PRODUTO", sku_components: [] },
  };

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
    //
    // D-351: mais duas, sem crescer com a página — os movimentos gravados e o
    // corte do ERP (do componente, que é quem tem saldo).
    expect(consultadas).toEqual(["orders", "sku_listing_links", "stock_movements", "rpc:get_erp_stock_cutoffs"]);
    expect(prefetch.cutoffBySku).toEqual(new Map([["sku-peca", null]]));
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

    const { db, consultadas } = dbFalso({ sku_listing_links: { data: [LINK_PRODUTO], error: null } });

    await prefetchOrders(db, CONTEXT, pagina);

    expect(consultadas).toEqual(["orders", "sku_listing_links", "stock_movements", "rpc:get_erp_stock_cutoffs"]);
  });

  it("página vazia não vai ao banco", async () => {
    const { db, consultadas } = dbFalso({});

    const prefetch = await prefetchOrders(db, CONTEXT, []);

    expect(consultadas).toEqual([]);
    expect(prefetch.linkByItemKey.size).toBe(0);
  });

  // D-351 — o corte e os movimentos gravados na página.

  it("D-351: página sem vínculo nem venda gravada não lê o corte — não há SKU para perguntar", async () => {
    const { db, consultadas } = dbFalso({});

    await prefetchOrders(db, CONTEXT, [PEDIDO_A]);

    expect(consultadas).not.toContain("rpc:get_erp_stock_cutoffs");
  });

  it("D-351: falha da leitura do corte na página LANÇA", async () => {
    const { db } = dbFalso({ sku_listing_links: { data: [LINK_PRODUTO], error: null } }, () => ({
      data: null,
      error: { message: "boom" },
    }));

    await expect(prefetchOrders(db, CONTEXT, [PEDIDO_A])).rejects.toThrow(/get_erp_stock_cutoffs.*boom/);
  });

  it("D-351: os movimentos gravados separam a venda do estorno, por pedido", async () => {
    const { db } = dbFalso({
      stock_movements: {
        data: [
          {
            source_id: String(PEDIDO_A.id),
            sku_id: "sku-1",
            qty_delta: -1,
            idempotency_key: "venda:2000017347483988:0",
            occurred_at: VENDA_EM,
            created_at: GRAVADO_EM,
            movement_type: "VENDA_ML",
          },
          {
            source_id: String(PEDIDO_A.id),
            sku_id: "sku-1",
            qty_delta: 1,
            idempotency_key: "estorno:venda:2000017347483988:0",
            occurred_at: VENDA_EM,
            created_at: GRAVADO_EM,
            movement_type: "ESTORNO_PRE_CAPTURA",
          },
        ],
        error: null,
      },
    });

    const prefetch = await prefetchOrders(db, CONTEXT, [PEDIDO_A]);
    const gravados = prefetch.recordedByOrderId.get(String(PEDIDO_A.id));

    expect(gravados?.sales).toEqual([
      {
        skuId: "sku-1",
        qtyDelta: -1,
        idempotencyKey: "venda:2000017347483988:0",
        occurredAt: new Date(VENDA_EM),
        recordedAt: new Date(GRAVADO_EM),
      },
    ]);
    expect([...(gravados?.estornadas ?? [])]).toEqual(["venda:2000017347483988:0"]);
    // A venda gravada tem SKU: o corte dele é lido mesmo sem vínculo hoje.
    expect(prefetch.cutoffBySku.has("sku-1")).toBe(true);
  });

  it("D-351: em lote, UMA leitura do corte para a página inteira, o par sai no mesmo lote e a página conta os estornos", async () => {
    const pagina = [1, 2, 3, 4, 5].map((id) => ({ ...BASE_ORDER, id }));
    const { db, consultadas } = dbFalso({ sku_listing_links: { data: [LINK_PRODUTO], error: null } }, (ids) => ({
      data: ids.map((id) => ({ sku_id: id, captured_at: CORTE, imported_at: IMPORTADO_EM, reconciled_at: null, exported_at: CORTE })),
      error: null,
    }));

    const prefetch = await prefetchOrders(db, CONTEXT, pagina);
    const writes = novaPagina(CONTEXT.organizationId);

    for (const order of pagina) {
      await persistOrder(db, CONTEXT, order, createLogger({}, { sink: () => undefined }), prefetch, writes);
    }

    expect(consultadas.filter((consulta) => consulta.startsWith("rpc:"))).toEqual(["rpc:get_erp_stock_cutoffs"]);

    const vendas = writes.movements.filter((m) => m.movementType === "VENDA_ML");
    const estornos = writes.movements.filter((m) => m.movementType === "ESTORNO_PRE_CAPTURA");

    expect(vendas).toHaveLength(5);
    expect(estornos).toHaveLength(5);
    expect(estornos.every((e) => e.draft.occurredAt.toISOString() === VENDA_EM)).toBe(true);
    expect(writes.estornosPreCaptura).toEqual({ pedidos: 5, movimentos: 5 });
  });
});

describe("persistOrder com prefetch (D-186)", () => {
  function prefetchDe(parcial: Partial<OrderPrefetch>): OrderPrefetch {
    return {
      previousStatusById: parcial.previousStatusById ?? new Map<string, string>(),
      linkByItemKey: parcial.linkByItemKey ?? new Map<string, ResolvedLink>(),
      recordedByOrderId: parcial.recordedByOrderId ?? new Map<string, RecordedOrderMovements>(),
      cutoffBySku: parcial.cutoffBySku ?? new Map<string, ErpCutoff | null>(),
      saleTransitionByOrderId: parcial.saleTransitionByOrderId ?? new Map<string, ObservedSaleTransition>(),
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
        cutoffBySku: new Map([["sku-9", null]]),
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
        cutoffBySku: new Map([["sku-peca", null]]),
      }),
    );

    const movimentos = inserted.filter((row) => row.table === "stock_movements").flatMap((row) => row.rows);

    // Kit não tem saldo próprio: a dedução vai para o componente.
    expect(movimentos).toHaveLength(1);
    expect((movimentos[0] as { sku_id: string }).sku_id).toBe("sku-peca");
  });

  // D-351: o prefetch sempre traz o corte de todo SKU vinculado da página. Se
  // um faltar, é defeito — e defeito aqui não pode virar "sem corte".
  it("D-351: prefetch sem o corte de um SKU que vai vender LANÇA, sem ir ao banco por conta própria", async () => {
    const { db, rpcCalls } = fakeDb({});

    await expect(
      persistOrder(
        db,
        CONTEXT,
        BASE_ORDER,
        createLogger({ service: "test" }),
        prefetchDe({
          linkByItemKey: new Map([
            ["MLB1054990648\u0000", { id: "link-9", sku_id: "sku-9", kind: "PRODUTO" as const, components: [] }],
          ]),
        }),
      ),
    ).rejects.toThrow(/corte do snapshot do ERP nao lido para o SKU sku-9/);

    expect(rpcCalls).toEqual([]);
  });
});

/**
 * Revisão de D-351 — os achados que o primeiro commit deixou passar.
 *
 *  - ALTA-1: a segunda planilha fazia o worker estornar venda legítima que a
 *    reconciliação já tinha absorvido. Agora só estorna venda gravada DEPOIS de
 *    o corte chegar (`imported_at`).
 *  - ALTA-2: venda anterior ao corte, nunca gravada e cancelada depois dele, não
 *    repunha estoque. Agora grava venda + estorno + cancelamento quando a V3 viu
 *    a transição — agora ou num `order.cancelled` já gravado.
 *  - MÉDIA-1: o prefetch em lote podia parar de ler os pedidos cancelados sem
 *    nenhum teste reprovar.
 */
describe("persistOrder — revisão de D-351", () => {
  const COM_VINCULO = { linkForItem: () => ({ id: "link-1", sku_id: "sku-1" }) };
  const PEDIDO = String(BASE_ORDER.id);
  const CANCELADO_EM = "2026-09-14T18:47:13.000Z";
  const CANCELADO: ParsedOrder = { ...BASE_ORDER, status: "cancelled", date_last_updated: CANCELADO_EM };

  function trio(inserted: { table: string; rows: unknown[] }[]): [string, string, number, string][] {
    return movimentos(inserted).map((m) => [m.movement_type, m.idempotency_key, m.qty_delta, m.occurred_at]);
  }

  describe("ALTA-1: venda gravada antes de a planilha chegar não é estornada", () => {
    it("segunda planilha: venda legítima gravada ANTES do import não ganha estorno quando o pedido é atualizado", async () => {
      // Venda de 09-15 12:00 gravada na hora; planilha exportada 09-16 18:00 e
      // importada 18:02; envio atualiza o pedido em 09-17.
      const { db, inserted } = fakeDb({
        ...COM_VINCULO,
        existingSaleMovements: [
          {
            sku_id: "sku-1",
            qty_delta: -1,
            idempotency_key: `venda:${PEDIDO}:0`,
            occurred_at: "2026-09-15T12:00:00.000Z",
            created_at: "2026-09-15T12:00:05.000Z",
          },
        ],
        cutoffs: { "sku-1": "2026-09-16T18:00:00.000Z" },
        cutoffImportedAt: "2026-09-16T18:02:00.000Z",
      });

      await run(db, {
        ...BASE_ORDER,
        date_closed: "2026-09-15T12:00:00.000Z",
        date_last_updated: "2026-09-17T10:00:00.000Z",
      });

      expect(movimentos(inserted).map((m) => m.movement_type)).toEqual(["VENDA_ML"]);
    });

    it("a mesma venda gravada DEPOIS do import (o estorno falhou antes do retry): estorna", async () => {
      const { db, inserted } = fakeDb({
        ...COM_VINCULO,
        existingSaleMovements: [
          { sku_id: "sku-1", qty_delta: -1, idempotency_key: `venda:${PEDIDO}:0`, created_at: "2026-09-14T18:44:18.715Z" },
        ],
        cutoffs: { "sku-1": CORTE },
      });

      await run(db, BASE_ORDER);

      expect(movimentos(inserted).map((m) => m.movement_type)).toEqual(["VENDA_ML", "ESTORNO_PRE_CAPTURA"]);
    });

    it("corte sem imported_at LANÇA — sem ele não há como saber se a venda gravada já estava no saldo", async () => {
      const { db, inserted } = fakeDb({
        ...COM_VINCULO,
        cutoffRows: [{ sku_id: "sku-1", captured_at: CORTE, imported_at: null }],
      });

      await expect(run(db, BASE_ORDER)).rejects.toThrow(/sem imported_at/);
      expect(inserted).toEqual([]);
    });
  });

  describe("ALTA-2: venda anterior ao corte, nunca gravada, cancelada depois dele", () => {
    it("transição vista agora (status anterior paid): grava venda e estorno com a venda em, e o cancelamento com o instante dele", async () => {
      const { db, inserted } = fakeDb({ ...COM_VINCULO, previousStatus: "paid", cutoffs: { "sku-1": CORTE } });
      const lines: string[] = [];

      await run(db, CANCELADO, lines);

      expect(trio(inserted)).toEqual([
        ["VENDA_ML", `venda:${PEDIDO}:0`, -1, VENDA_EM],
        ["ESTORNO_PRE_CAPTURA", `estorno:venda:${PEDIDO}:0`, 1, VENDA_EM],
        ["CANCELAMENTO_ML", `cancelamento:venda:${PEDIDO}:0`, 1, CANCELADO_EM],
      ]);
      expect(lines.join()).toContain("cancellation_repoe_venda_anterior_ao_corte");
    });

    it("sem transição (o banco já tinha o pedido cancelado e não há evento de venda): não grava nada", async () => {
      const { db, inserted } = fakeDb({ ...COM_VINCULO, previousStatus: "cancelled", cutoffs: { "sku-1": CORTE } });

      await run(db, CANCELADO);

      expect(movimentos(inserted)).toEqual([]);
    });

    it("pedido novo para a V3 já cancelado (backfill): não grava nada", async () => {
      const { db, inserted } = fakeDb({ ...COM_VINCULO, cutoffs: { "sku-1": CORTE } });

      await run(db, CANCELADO);

      expect(movimentos(inserted)).toEqual([]);
    });

    it("retry: o pedido já foi regravado cancelado, mas o order.cancelled de paid gravado repõe", async () => {
      const { db, inserted } = fakeDb({
        ...COM_VINCULO,
        previousStatus: "cancelled",
        cancelledEvents: [{ before: { status: "paid" }, occurred_at: CANCELADO_EM }],
        cutoffs: { "sku-1": CORTE },
      });

      await run(db, { ...CANCELADO, date_last_updated: "2026-09-14T18:51:14.000Z" });

      expect(trio(inserted).map(([tipo]) => tipo)).toEqual(["VENDA_ML", "ESTORNO_PRE_CAPTURA", "CANCELAMENTO_ML"]);
    });

    it("evento gravado de transição que não é venda (confirmed -> cancelled): não grava nada", async () => {
      const { db, inserted } = fakeDb({
        ...COM_VINCULO,
        previousStatus: "cancelled",
        cancelledEvents: [{ before: { status: "confirmed" }, occurred_at: CANCELADO_EM }],
        cutoffs: { "sku-1": CORTE },
      });

      await run(db, CANCELADO);

      expect(movimentos(inserted)).toEqual([]);
    });

    it("cancelada ATÉ o corte: não grava nada — a planilha tem a venda e a devolução", async () => {
      const { db, inserted } = fakeDb({ ...COM_VINCULO, previousStatus: "paid", cutoffs: { "sku-1": CORTE } });

      await run(db, { ...CANCELADO, date_last_updated: CORTE });

      expect(movimentos(inserted)).toEqual([]);
    });

    it("retry depois de a venda gravar e o estorno falhar: grava o estorno e o cancelamento, sem depender da transição", async () => {
      const { db, inserted } = fakeDb({
        ...COM_VINCULO,
        previousStatus: "cancelled",
        existingSaleMovements: [{ sku_id: "sku-1", qty_delta: -1, idempotency_key: `venda:${PEDIDO}:0` }],
        cutoffs: { "sku-1": CORTE },
      });

      await run(db, CANCELADO);

      expect(trio(inserted).map(([tipo]) => tipo)).toEqual(["ESTORNO_PRE_CAPTURA", "CANCELAMENTO_ML"]);
    });

    it("falha na leitura dos eventos LANÇA antes de qualquer escrita — nunca vira 'não houve transição'", async () => {
      const { db, inserted, upserted } = fakeDb({
        ...COM_VINCULO,
        previousStatus: "cancelled",
        eventsReadError: true,
        cutoffs: { "sku-1": CORTE },
      });

      await expect(run(db, CANCELADO)).rejects.toThrow(/domain_events.*boom/);
      expect(upserted).toEqual([]);
      expect(inserted).toEqual([]);
    });
  });

  it("chave neutra: estorno gravado com a chave de uma causa (fora do formato) LANÇA em vez de parecer não estornado", async () => {
    const { db, inserted } = fakeDb({
      ...COM_VINCULO,
      existingSaleMovements: [
        { sku_id: "sku-1", qty_delta: -1, idempotency_key: `venda:${PEDIDO}:0` },
        {
          sku_id: "sku-1",
          qty_delta: 1,
          idempotency_key: `estorno-pre-captura:venda:${PEDIDO}:0`,
          movement_type: "ESTORNO_PRE_CAPTURA",
        },
      ],
      cutoffs: { "sku-1": CORTE },
    });

    await expect(run(db, BASE_ORDER)).rejects.toThrow(/fora do formato/);
    expect(inserted).toEqual([]);
  });

  describe("em lote (janela horária e backfill)", () => {
    const LINK = {
      id: "link-1",
      sku_id: "sku-1",
      item_id: "MLB1054990648",
      variation_id: null,
      skus: { kind: "PRODUTO", sku_components: [] },
    };

    function paginaFalsa(porTabela: Record<string, unknown[]>) {
      const consultadas: string[] = [];

      const cadeia = (data: unknown[]) => {
        const self = {
          select: () => self,
          eq: () => self,
          in: () => self,
          then: <R>(onFulfilled: (value: { data: unknown[]; error: null }) => R) =>
            Promise.resolve({ data, error: null }).then(onFulfilled),
        };

        return self;
      };

      const db = {
        from: (table: string) => {
          consultadas.push(table);

          return cadeia(porTabela[table] ?? []);
        },
        rpc: (fn: string, args: { p_sku_ids: string[]; p_order_ids: string[] }) => {
          consultadas.push(`rpc:${fn}`);

          if (fn === "get_order_return_movements") {
            const pedidos = new Set(args.p_order_ids);

            return Promise.resolve({
              data: (porTabela["rpc:get_order_return_movements"] ?? []).filter((row) =>
                pedidos.has((row as { order_id: string }).order_id),
              ),
              error: null,
            });
          }

          return Promise.resolve({
            data: args.p_sku_ids.map((id) => ({
              sku_id: id,
              captured_at: CORTE,
              imported_at: IMPORTADO_EM,
              reconciled_at: null,
              exported_at: CORTE,
            })),
            error: null,
          });
        },
      } as unknown as Parameters<typeof prefetchOrders>[0];

      return { db, consultadas };
    }

    async function persistePagina(db: Parameters<typeof prefetchOrders>[0], pagina: ParsedOrder[]) {
      const prefetch = await prefetchOrders(db, CONTEXT, pagina);
      const writes = novaPagina(CONTEXT.organizationId);

      for (const order of pagina) {
        await persistOrder(db, CONTEXT, order, createLogger({}, { sink: () => undefined }), prefetch, writes);
      }

      return writes.movements.map((m) => [m.movementType, m.draft.idempotencyKey]);
    }

    it("MÉDIA-1: a página lê os movimentos gravados do pedido CANCELADO e grava o CANCELAMENTO_ML", async () => {
      // Venda legítima (depois do corte): o cancelamento só reverte, sem estorno.
      const pedido: ParsedOrder = {
        ...BASE_ORDER,
        id: 7,
        status: "cancelled",
        date_closed: "2026-09-20T10:00:00.000Z",
        date_last_updated: "2026-09-20T11:00:00.000Z",
      };
      const { db } = paginaFalsa({
        orders: [{ id: 7, status: "cancelled" }],
        stock_movements: [
          {
            source_id: "7",
            sku_id: "sku-1",
            qty_delta: -1,
            idempotency_key: "venda:7:0",
            occurred_at: "2026-09-20T10:00:00.000Z",
            created_at: "2026-09-20T10:00:01.000Z",
            movement_type: "VENDA_ML",
          },
        ],
      });

      expect(await persistePagina(db, [pedido])).toEqual([["CANCELAMENTO_ML", "cancelamento:venda:7:0"]]);
    });

    it("ALTA-2 na página: a transição gravada em domain_events repõe a venda nunca gravada, com UMA leitura de eventos", async () => {
      const pedido: ParsedOrder = { ...CANCELADO, id: 8 };
      const { db, consultadas } = paginaFalsa({
        orders: [{ id: 8, status: "cancelled" }],
        sku_listing_links: [LINK],
        domain_events: [{ entity_id: "8", before: { status: "paid" }, occurred_at: CANCELADO_EM }],
      });

      expect(await persistePagina(db, [pedido])).toEqual([
        ["VENDA_ML", "venda:8:0"],
        ["ESTORNO_PRE_CAPTURA", "estorno:venda:8:0"],
        ["CANCELAMENTO_ML", "cancelamento:venda:8:0"],
      ]);
      expect(consultadas.filter((tabela) => tabela === "domain_events")).toHaveLength(1);
    });

    it("página só de pedidos pagos não lê domain_events", async () => {
      const { db, consultadas } = paginaFalsa({ sku_listing_links: [LINK] });

      await persistePagina(db, [{ ...BASE_ORDER, id: 9 }]);

      expect(consultadas).not.toContain("domain_events");
    });

    it("verificação de e6fda07, ALTA-1: a página lê as devoluções gravadas dos pedidos com venda, e o cancelamento não devolve de novo", async () => {
      const pedido: ParsedOrder = {
        ...BASE_ORDER,
        id: 7,
        status: "cancelled",
        date_closed: "2026-09-20T10:00:00.000Z",
        date_last_updated: "2026-09-22T11:00:00.000Z",
      };
      const venda = {
        source_id: "7",
        sku_id: "sku-1",
        qty_delta: -1,
        idempotency_key: "venda:7:0",
        occurred_at: "2026-09-20T10:00:00.000Z",
        created_at: "2026-09-20T10:00:01.000Z",
        movement_type: "VENDA_ML",
      };
      const { db, consultadas } = paginaFalsa({
        orders: [{ id: 7, status: "cancelled" }],
        stock_movements: [venda],
        "rpc:get_order_return_movements": [
          { order_id: "7", sku_id: "sku-1", qty_delta: 1, idempotency_key: "devolucao:5570995770:venda:7:0" },
        ],
      });

      expect(await persistePagina(db, [pedido])).toEqual([]);
      expect(consultadas.filter((consulta) => consulta === "rpc:get_order_return_movements")).toHaveLength(1);
    });
  });
});

/**
 * Verificação independente de e6fda07 (D-351). Cada bloco nomeia o achado que
 * o sustenta; as mutações de D-351 §9 reprovam estes testes.
 */
describe("persistOrder — verificação de e6fda07", () => {
  const PEDIDO = String(BASE_ORDER.id);
  const VENDA = `venda:${PEDIDO}:0`;
  const COM_VINCULO = { linkForItem: () => ({ id: "link-1", sku_id: "sku-1" }) };

  function linhas(inserted: { table: string; rows: unknown[] }[]): [string, string, number, string][] {
    return movimentos(inserted).map((m) => [m.movement_type, m.idempotency_key, m.qty_delta, m.occurred_at]);
  }

  describe("ALTA-1: cancelamento e devolução revertem a MESMA venda — a unidade volta ao estoque no máximo uma vez", () => {
    it("2000018212899604 de produção (VENDA do worker antigo + DEVOLUCAO + CANCELAMENTO): nenhum estorno e nenhuma reversão nova — o líquido fica +1", async () => {
      const CANCELADO_EM = "2026-09-15T08:40:07.000Z";
      const { db, inserted, rpcCalls } = fakeDb({
        ...COM_VINCULO,
        previousStatus: "cancelled",
        existingSaleMovements: [
          {
            sku_id: "sku-1",
            qty_delta: -1,
            idempotency_key: VENDA,
            occurred_at: "2026-09-15T01:50:58.000Z",
            created_at: "2026-09-15T02:00:05.948Z",
          },
          {
            sku_id: "sku-1",
            qty_delta: 1,
            idempotency_key: `cancelamento:${VENDA}`,
            movement_type: "CANCELAMENTO_ML",
            occurred_at: CANCELADO_EM,
          },
        ],
        recordedReturns: [{ sku_id: "sku-1", qty_delta: 1, idempotency_key: `devolucao:5570995770:${VENDA}` }],
        cutoffs: { "sku-1": CORTE },
      });
      const lines: string[] = [];

      await run(
        db,
        {
          ...BASE_ORDER,
          status: "cancelled",
          date_created: "2026-08-31T21:05:28.000Z",
          date_closed: "2026-08-31T21:05:29.000Z",
          date_last_updated: CANCELADO_EM,
        },
        lines,
      );

      expect(movimentos(inserted)).toEqual([]);
      expect(lines.join()).toContain("cancellation_reversal_ja_revertida");
      expect(rpcCalls).toContainEqual({
        fn: "get_order_return_movements",
        args: { p_organization_id: CONTEXT.organizationId, p_order_ids: [PEDIDO] },
      });
    });

    it("devolução entregue primeiro, cancelamento depois: o cancelamento não devolve a unidade de novo, e registra", async () => {
      const { db, inserted } = fakeDb({
        ...COM_VINCULO,
        previousStatus: "paid",
        existingSaleMovements: [
          {
            sku_id: "sku-1",
            qty_delta: -1,
            idempotency_key: VENDA,
            occurred_at: "2026-09-20T10:00:00.000Z",
            created_at: "2026-09-20T10:00:01.000Z",
          },
        ],
        recordedReturns: [{ sku_id: "sku-1", qty_delta: 1, idempotency_key: `devolucao:5570995770:${VENDA}` }],
        cutoffs: { "sku-1": CORTE },
      });
      const lines: string[] = [];

      await run(
        db,
        {
          ...BASE_ORDER,
          status: "cancelled",
          date_created: "2026-09-20T09:59:00.000Z",
          date_closed: "2026-09-20T10:00:00.000Z",
          date_last_updated: "2026-09-22T11:00:00.000Z",
        },
        lines,
      );

      expect(movimentos(inserted)).toEqual([]);
      expect(lines.join()).toContain("cancellation_reversal_ja_revertida");
    });

    it("falha na leitura das devoluções gravadas LANÇA antes de qualquer escrita — nunca vira 'nenhuma devolução'", async () => {
      const { db, inserted, upserted } = fakeDb({
        ...COM_VINCULO,
        existingSaleMovements: [{ sku_id: "sku-1", qty_delta: -1, idempotency_key: VENDA }],
        returnsReadError: true,
        cutoffs: { "sku-1": CORTE },
      });

      await expect(run(db, BASE_ORDER)).rejects.toThrow(/get_order_return_movements.*boom/);
      expect(upserted).toEqual([]);
      expect(inserted).toEqual([]);
    });

    it("reversão gravada com chave fora do formato LANÇA na leitura — mesmo num pedido pago, sem corte, em que o domínio não chegaria a usá-la", async () => {
      // Sem corte (organização sem snapshot) e pedido pago: nenhuma conta do domínio passa
      // pela reversão. Só a conferência da leitura grita -- dado corrompido não fica quieto
      // até o dia em que o pedido cancelar.
      const { db, inserted } = fakeDb({
        ...COM_VINCULO,
        existingSaleMovements: [
          { sku_id: "sku-1", qty_delta: -1, idempotency_key: VENDA },
          { sku_id: "sku-1", qty_delta: 1, idempotency_key: `cancelamento:${PEDIDO}:0`, movement_type: "CANCELAMENTO_ML" },
        ],
      });

      await expect(run(db, BASE_ORDER)).rejects.toThrow(/chave de reversao fora do formato/);
      expect(inserted).toEqual([]);
    });
  });

  describe("MÉDIA-1 (corte): o último alinhamento do saldo decide a venda já gravada", () => {
    it("(b) linha até o corte gravada depois do import e ANTES da reconciliação: atualizar o pedido não estorna — a reconciliação a absorveu", async () => {
      const { db, inserted } = fakeDb({
        ...COM_VINCULO,
        existingSaleMovements: [{ sku_id: "sku-1", qty_delta: -1, idempotency_key: VENDA, created_at: GRAVADO_EM }],
        cutoffs: { "sku-1": CORTE },
        cutoffReconciledAt: "2026-09-15T09:00:00.000Z",
      });

      await run(db, BASE_ORDER);

      expect(movimentos(inserted).map((m) => m.movement_type)).toEqual(["VENDA_ML"]);
    });

    it("(b) a mesma linha gravada DEPOIS da reconciliação: estorna", async () => {
      const { db, inserted } = fakeDb({
        ...COM_VINCULO,
        existingSaleMovements: [{ sku_id: "sku-1", qty_delta: -1, idempotency_key: VENDA, created_at: GRAVADO_EM }],
        cutoffs: { "sku-1": CORTE },
        cutoffReconciledAt: "2026-09-14T18:50:00.000Z",
      });

      await run(db, BASE_ORDER);

      expect(movimentos(inserted).map((m) => m.movement_type)).toEqual(["VENDA_ML", "ESTORNO_PRE_CAPTURA"]);
    });

    it("(a) linha do worker antigo com occurred_at DEPOIS do corte, gravada antes do import e da reconciliação: estorna, espelhada", async () => {
      const { db, inserted } = fakeDb({
        ...COM_VINCULO,
        existingSaleMovements: [
          {
            sku_id: "sku-1",
            qty_delta: -1,
            idempotency_key: VENDA,
            occurred_at: "2026-09-14T19:03:00.000Z",
            created_at: "2026-09-14T18:00:00.000Z",
          },
        ],
        cutoffs: { "sku-1": CORTE },
        cutoffReconciledAt: "2026-09-15T09:00:00.000Z",
      });

      await run(db, BASE_ORDER);

      expect(linhas(inserted).filter(([tipo]) => tipo === "ESTORNO_PRE_CAPTURA")).toEqual([
        ["ESTORNO_PRE_CAPTURA", `estorno:${VENDA}`, 1, "2026-09-14T19:03:00.000Z"],
      ]);
    });
  });

  describe("MÉDIA-1 (bateria): o trio só repõe pedido SEM nenhum VENDA_ML gravado", () => {
    const CANCELADO_DEPOIS: ParsedOrder = { ...BASE_ORDER, status: "cancelled", date_last_updated: "2026-09-15T10:00:00.000Z" };

    it("KIT com composição alterada (A1+A2 -> A1+B2) entre a venda e o cancelamento: só reverte o gravado, e B2 não ganha nada", async () => {
      const { db, inserted } = fakeDb({
        linkForItem: () => ({ id: "link-kit", sku_id: "sku-kit" }),
        skuKindById: () => "KIT",
        componentsByKitId: () => [
          { component_sku_id: "sku-a1", quantity: 1 },
          { component_sku_id: "sku-b2", quantity: 1 },
        ],
        previousStatus: "paid",
        existingSaleMovements: [
          { sku_id: "sku-a1", qty_delta: -1, idempotency_key: `${VENDA}:sku-a1` },
          { sku_id: "sku-a2", qty_delta: -1, idempotency_key: `${VENDA}:sku-a2` },
          { sku_id: "sku-a1", qty_delta: 1, idempotency_key: `estorno:${VENDA}:sku-a1`, movement_type: "ESTORNO_PRE_CAPTURA" },
          { sku_id: "sku-a2", qty_delta: 1, idempotency_key: `estorno:${VENDA}:sku-a2`, movement_type: "ESTORNO_PRE_CAPTURA" },
        ],
        cutoffs: { "sku-a1": CORTE, "sku-a2": CORTE, "sku-b2": CORTE },
      });

      await run(db, CANCELADO_DEPOIS);

      expect(movimentos(inserted).map((m) => [m.movement_type, m.sku_id, m.qty_delta])).toEqual([
        ["CANCELAMENTO_ML", "sku-a1", 1],
        ["CANCELAMENTO_ML", "sku-a2", 1],
      ]);
    });

    it("PRODUTO P que virou KIT C1+C2: só reverte a venda de P, nada para C1 e C2", async () => {
      const { db, inserted } = fakeDb({
        linkForItem: () => ({ id: "link-kit", sku_id: "sku-kit" }),
        skuKindById: () => "KIT",
        componentsByKitId: () => [
          { component_sku_id: "sku-c1", quantity: 1 },
          { component_sku_id: "sku-c2", quantity: 2 },
        ],
        previousStatus: "paid",
        existingSaleMovements: [
          { sku_id: "sku-p", qty_delta: -1, idempotency_key: VENDA },
          { sku_id: "sku-p", qty_delta: 1, idempotency_key: `estorno:${VENDA}`, movement_type: "ESTORNO_PRE_CAPTURA" },
        ],
        cutoffs: { "sku-p": CORTE, "sku-c1": CORTE, "sku-c2": CORTE },
      });

      await run(db, CANCELADO_DEPOIS);

      expect(movimentos(inserted).map((m) => [m.movement_type, m.sku_id, m.qty_delta])).toEqual([
        ["CANCELAMENTO_ML", "sku-p", 1],
      ]);
    });
  });

  describe("MÉDIA-2 (bateria): o estorno gerado no próprio cancelamento conta como estornado", () => {
    it("venda gravada depois do import, sem estorno, e cancelada com instante conhecido ATÉ o corte: só o ESTORNO, nenhum CANCELAMENTO_ML", async () => {
      const { db, inserted } = fakeDb({
        ...COM_VINCULO,
        previousStatus: "cancelled",
        existingSaleMovements: [{ sku_id: "sku-1", qty_delta: -1, idempotency_key: VENDA, created_at: GRAVADO_EM }],
        cutoffs: { "sku-1": CORTE },
      });

      await run(db, { ...BASE_ORDER, status: "cancelled", date_last_updated: "2026-09-14T18:30:00.000Z" });

      expect(linhas(inserted)).toEqual([["ESTORNO_PRE_CAPTURA", `estorno:${VENDA}`, 1, VENDA_EM]]);
    });
  });

  describe("BAIXA-1 (cancelamento): o trio com o instante desta leitura desconhecido", () => {
    it("o CANCELAMENTO_ML leva o instante do order.cancelled gravado (posterior ao corte), e não date_created", async () => {
      const CANCELADO_EM = "2026-09-14T18:47:13.000Z";
      const { db, inserted } = fakeDb({
        ...COM_VINCULO,
        previousStatus: "cancelled",
        cancelledEvents: [{ before: { status: "paid" }, occurred_at: CANCELADO_EM }],
        cutoffs: { "sku-1": CORTE },
      });

      await run(db, { ...BASE_ORDER, status: "cancelled", date_last_updated: undefined, last_updated: undefined });

      expect(linhas(inserted)).toEqual([
        ["VENDA_ML", VENDA, -1, VENDA_EM],
        ["ESTORNO_PRE_CAPTURA", `estorno:${VENDA}`, 1, VENDA_EM],
        ["CANCELAMENTO_ML", `cancelamento:${VENDA}`, 1, CANCELADO_EM],
      ]);
    });
  });

  describe("BAIXA-3 (corte): linha da RPC sem a coluna, ou com data ilegível, LANÇA", () => {
    it("sem a chave imported_at (a RPC na forma de 1e7e6f6): LANÇA, em vez de virar Invalid Date e estornar toda venda gravada", async () => {
      const { db, inserted } = fakeDb({ ...COM_VINCULO, cutoffRows: [{ sku_id: "sku-1", captured_at: CORTE }] });

      await expect(run(db, BASE_ORDER)).rejects.toThrow(/sem imported_at/);
      expect(inserted).toEqual([]);
    });

    it("sem a chave reconciled_at (a RPC na forma de e6fda07): LANÇA", async () => {
      const { db, inserted } = fakeDb({
        ...COM_VINCULO,
        cutoffRows: [{ sku_id: "sku-1", captured_at: CORTE, imported_at: IMPORTADO_EM }],
      });

      await expect(run(db, BASE_ORDER)).rejects.toThrow(/sem reconciled_at/);
      expect(inserted).toEqual([]);
    });

    it("data ilegível: LANÇA", async () => {
      const { db, inserted } = fakeDb({
        ...COM_VINCULO,
        cutoffRows: [{ sku_id: "sku-1", captured_at: CORTE, imported_at: "ontem", reconciled_at: null }],
      });

      await expect(run(db, BASE_ORDER)).rejects.toThrow(/imported_at ilegivel/);
      expect(inserted).toEqual([]);
    });
  });

  describe("webhook: as vendas do trio num comando só", () => {
    it("KIT: as vendas dos dois componentes vão num único upsert — uma falha entre eles não deixa metade gravada, que o retry não completaria", async () => {
      const { db, inserted } = fakeDb({
        linkForItem: () => ({ id: "link-kit", sku_id: "sku-kit" }),
        skuKindById: () => "KIT",
        componentsByKitId: () => [
          { component_sku_id: "sku-c1", quantity: 1 },
          { component_sku_id: "sku-c2", quantity: 2 },
        ],
        previousStatus: "paid",
        cutoffs: { "sku-c1": CORTE, "sku-c2": CORTE },
      });

      await run(db, { ...BASE_ORDER, status: "cancelled", date_last_updated: "2026-09-15T10:00:00.000Z" });

      const escritasDeVenda = inserted.filter(
        (entry) =>
          entry.table === "stock_movements" &&
          (entry.rows as MovimentoGravado[]).some((row) => row.movement_type === "VENDA_ML"),
      );

      expect(escritasDeVenda.map((entry) => entry.rows.length)).toEqual([2]);
    });
  });
});

/**
 * Reverificação de c48fb70 (D-351 §10). Cada bloco nomeia o achado; as mutações
 * da §10 reprovam estes testes.
 */
describe("persistOrder — reverificação de c48fb70", () => {
  const PEDIDO = String(BASE_ORDER.id);
  const VENDA = `venda:${PEDIDO}:0`;
  const COM_VINCULO = { linkForItem: () => ({ id: "link-1", sku_id: "sku-1" }) };

  function tiposGravados(inserted: { table: string; rows: unknown[] }[]): string[] {
    return movimentos(inserted).map((m) => m.movement_type);
  }

  describe("MÉDIA-1: o snapshot que ainda carrega o parse retrata a exportação do nome do arquivo", () => {
    // Dev: Lista_de_Estoque_0820160923.xlsx, parse em 08-21 15:42:02.459 (o corte que a migration
    // deixa na organização reconciliada), exportada em 08-20 16:09:23.
    const DEV = {
      cutoffs: { "sku-1": "2026-08-21T15:42:02.459Z" },
      cutoffImportedAt: "2026-08-21T17:12:44.481Z",
      cutoffReconciledAt: "2026-09-14T09:00:09.295Z",
      cutoffExportedAt: "2026-08-20T16:09:23.000Z",
    };
    // 2000018048056108: VENDA_ML do worker antigo, com a data da atualização (09-06).
    const LINHA_DO_WORKER_ANTIGO = [
      {
        sku_id: "sku-1",
        qty_delta: -1,
        idempotency_key: VENDA,
        occurred_at: "2026-09-06T12:33:31.000Z",
        created_at: "2026-09-06T12:33:33.116Z",
      },
    ];

    it("linha do worker antigo depois do corte, de venda ENTRE a exportação e o parse: atualizar o pedido não estorna", async () => {
      const { db, inserted } = fakeDb({ ...COM_VINCULO, ...DEV, existingSaleMovements: LINHA_DO_WORKER_ANTIGO });

      await run(db, { ...BASE_ORDER, date_closed: "2026-08-21T12:37:59.000Z" });

      expect(tiposGravados(inserted)).toEqual(["VENDA_ML"]);
    });

    it("a mesma linha, de venda ANTES da exportação: estorna — a planilha tem a venda", async () => {
      const { db, inserted } = fakeDb({ ...COM_VINCULO, ...DEV, existingSaleMovements: LINHA_DO_WORKER_ANTIGO });

      await run(db, { ...BASE_ORDER, date_closed: "2026-08-20T10:00:00.000Z" });

      expect(tiposGravados(inserted)).toEqual(["VENDA_ML", "ESTORNO_PRE_CAPTURA"]);
    });

    it("sem a chave exported_at (a RPC na forma de c48fb70): LANÇA, em vez de decidir a planilha pelo corte do alvo", async () => {
      const { db, inserted } = fakeDb({
        ...COM_VINCULO,
        cutoffRows: [{ sku_id: "sku-1", captured_at: CORTE, imported_at: IMPORTADO_EM, reconciled_at: null }],
      });

      await expect(run(db, BASE_ORDER)).rejects.toThrow(/sem exported_at/);
      expect(inserted).toEqual([]);
    });
  });

  describe("MUT-X2: a linha gravada NO corte fica fora do alvo, como no SQL", () => {
    it("venda fechada no segundo da exportação, gravada antes do import e sem reconciliação: atualizar o pedido não estorna", async () => {
      const { db, inserted } = fakeDb({
        ...COM_VINCULO,
        existingSaleMovements: [
          { sku_id: "sku-1", qty_delta: -1, idempotency_key: VENDA, occurred_at: CORTE, created_at: "2026-09-14T18:42:03.000Z" },
        ],
        cutoffs: { "sku-1": CORTE },
      });

      await run(db, { ...BASE_ORDER, date_closed: CORTE });

      expect(tiposGravados(inserted)).toEqual(["VENDA_ML"]);
    });
  });
});

describe("persistOrder — reverificação de 60c7a6a", () => {
  const PEDIDO = String(BASE_ORDER.id);
  const COM_VINCULO = { linkForItem: () => ({ id: "link-1", sku_id: "sku-1" }) };
  const CANCELADO_EM = "2026-09-14T19:07:45.000Z";

  describe("MÉDIA-1: a fronteira da venda no trio é a mesma do gate da venda", () => {
    it("pedido fechado NO instante da exportação, sem VENDA_ML, cancelado depois dela com a transição vista: grava venda, estorno e cancelamento", async () => {
      const { db, inserted } = fakeDb({ ...COM_VINCULO, previousStatus: "paid", cutoffs: { "sku-1": CORTE } });

      await run(db, { ...BASE_ORDER, status: "cancelled", date_closed: CORTE, date_last_updated: CANCELADO_EM });

      // A planilha tem a venda (o gate a estorna, `<=`) e o UpSeller devolveu a unidade depois dela.
      expect(movimentos(inserted).map((m) => [m.movement_type, m.idempotency_key, m.qty_delta, m.occurred_at])).toEqual([
        ["VENDA_ML", `venda:${PEDIDO}:0`, -1, CORTE],
        ["ESTORNO_PRE_CAPTURA", `estorno:venda:${PEDIDO}:0`, 1, CORTE],
        ["CANCELAMENTO_ML", `cancelamento:venda:${PEDIDO}:0`, 1, CANCELADO_EM],
      ]);
    });
  });
});
