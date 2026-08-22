import { createLogger } from "@sb/observability";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { describe, expect, it } from "vitest";

import type { FetchFulfillmentSnapshotsParams } from "./ml-fulfillment-fetch.js";
import { fetchFulfillmentSnapshots } from "./ml-fulfillment-fetch.js";

const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const CAPTURED_AT = new Date("2026-08-22T14:00:00.000Z");

interface Link {
  item_id: string | null;
  sku_id: string;
}

interface PreviousSnapshot {
  quantity: number;
  captured_at: string;
}

/** Fake mínimo, encadeável e thenable — mesmo espírito de sync-orders-window.test.ts. */
function chain<T>(result: T): {
  eq: () => ReturnType<typeof chain<T>>;
  is: () => ReturnType<typeof chain<T>>;
  order: () => ReturnType<typeof chain<T>>;
  limit: () => ReturnType<typeof chain<T>>;
  maybeSingle: () => Promise<T>;
  then: <R>(resolve: (value: T) => R) => Promise<R>;
} {
  const self = {
    eq: () => self,
    is: () => self,
    order: () => self,
    limit: () => self,
    maybeSingle: () => Promise.resolve(result),
    then: <R>(resolve: (value: T) => R) => Promise.resolve(result).then(resolve),
  };

  return self;
}

function fakeDb(options: {
  links?: Link[];
}): {
  db: FetchFulfillmentSnapshotsParams["db"];
  inserted: { table: string; row: Record<string, unknown> }[];
} {
  const links = options.links ?? [];
  const inserted: { table: string; row: Record<string, unknown> }[] = [];

  const db = {
    from: (table: string) => ({
      select: () => {
        if (table === "sku_listing_links") {
          return chain({ data: links, error: null });
        }

        // fulfillment_stock_snapshots (previous lookup): capturado pelo
        // `.eq("inventory_id", ...)` — como o fake genérico não guarda
        // filtros, devolvemos via um proxy que resolve no `then`/`maybeSingle`
        // olhando o encadeamento inteiro não é possível aqui sem duplicar a
        // lib real; em vez disso, o teste usa UM inventory_id por vez quando
        // precisa afirmar sobre "previous" específico (ver descrição abaixo).
        return chain({ data: null, error: null });
      },
      insert: (row: Record<string, unknown>) => {
        inserted.push({ table, row });

        return Promise.resolve({ data: null, error: null });
      },
    }),
  } as unknown as FetchFulfillmentSnapshotsParams["db"];

  return { db, inserted };
}

/**
 * Fake com resolução de `previous` por `inventory_id`, para os testes que
 * precisam de um "antes" específico — acumula os filtros de cada `.eq()`
 * na cadeia (mesma técnica de `filterChain` em `persist-order.test.ts`),
 * porque `inventory_id` é o SEGUNDO `.eq()`, não o primeiro.
 */
function fakeDbWithPrevious(
  links: Link[],
  previousByInventoryId: Record<string, PreviousSnapshot>,
): {
  db: FetchFulfillmentSnapshotsParams["db"];
  inserted: { table: string; row: Record<string, unknown> }[];
} {
  const inserted: { table: string; row: Record<string, unknown> }[] = [];

  function snapshotFilterChain(filters: Record<string, unknown>): {
    eq: (col: string, val: unknown) => ReturnType<typeof snapshotFilterChain>;
    order: () => ReturnType<typeof snapshotFilterChain>;
    limit: () => ReturnType<typeof snapshotFilterChain>;
    maybeSingle: () => Promise<{ data: unknown; error: null }>;
  } {
    const self = {
      eq: (col: string, val: unknown) => snapshotFilterChain({ ...filters, [col]: val }),
      order: () => self,
      limit: () => self,
      maybeSingle: () => {
        const inventoryId = filters.inventory_id as string | undefined;
        const previous = inventoryId !== undefined ? (previousByInventoryId[inventoryId] ?? null) : null;

        return Promise.resolve({ data: previous, error: null });
      },
    };

    return self;
  }

  const db = {
    from: (table: string) => ({
      select: () => {
        if (table === "sku_listing_links") {
          return chain({ data: links, error: null });
        }

        return snapshotFilterChain({});
      },
      insert: (row: Record<string, unknown>) => {
        inserted.push({ table, row });

        return Promise.resolve({ data: null, error: null });
      },
    }),
  } as unknown as FetchFulfillmentSnapshotsParams["db"];

  return { db, inserted };
}

function fakeMercadoLivreClient(
  itemsById: Record<string, { id: string; inventory_id: string | null }>,
  stockByInventoryId: Record<string, { inventory_id: string; available_quantity: number }>,
): { client: MercadoLivreClient; requests: RequestOptions<unknown>[] } {
  const requests: RequestOptions<unknown>[] = [];

  const client = {
    request: (options: RequestOptions<unknown>) => {
      requests.push(options);

      const itemMatch = /^\/items\/(.+)$/.exec(options.path);

      if (itemMatch?.[1] !== undefined) {
        const item = itemsById[itemMatch[1]];

        return Promise.resolve(item ?? { id: itemMatch[1], inventory_id: null });
      }

      const stockMatch = /^\/inventories\/(.+)\/stock\/fulfillment$/.exec(options.path);

      if (stockMatch?.[1] !== undefined) {
        const stock = stockByInventoryId[stockMatch[1]];

        return Promise.resolve(stock ?? { inventory_id: stockMatch[1], available_quantity: 0 });
      }

      throw new Error(`caminho inesperado no fake: ${options.path}`);
    },
  } as unknown as MercadoLivreClient;

  return { client, requests };
}

function baseParams(
  db: FetchFulfillmentSnapshotsParams["db"],
  client: MercadoLivreClient,
  lines: string[] = [],
): FetchFulfillmentSnapshotsParams {
  return {
    db,
    organizationId: ORGANIZATION_ID,
    mlAccountId: ML_ACCOUNT_ID,
    mercadoLivre: client,
    accessToken: "APP_USR-token",
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    now: () => CAPTURED_AT,
  };
}

describe("fetchFulfillmentSnapshots", () => {
  it("nenhum vínculo sem variação: zero processados, zero pulados", async () => {
    const { db } = fakeDb({ links: [] });
    const { client, requests } = fakeMercadoLivreClient({}, {});

    const result = await fetchFulfillmentSnapshots(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 0, itemsSkipped: 0, itemsFailed: 0 });
    expect(requests).toHaveLength(0);
  });

  it("item nunca enviado ao Full (inventory_id nulo): conta como skipped, não grava snapshot", async () => {
    const { db, inserted } = fakeDb({ links: [{ item_id: "MLB1", sku_id: "sku-1" }] });
    const { client } = fakeMercadoLivreClient({ MLB1: { id: "MLB1", inventory_id: null } }, {});

    const result = await fetchFulfillmentSnapshots(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 0, itemsSkipped: 1, itemsFailed: 0 });
    expect(inserted.find((e) => e.table === "fulfillment_stock_snapshots")).toBeUndefined();
  });

  it("item no Full: grava snapshot com available_quantity e a chave certa", async () => {
    const { db, inserted } = fakeDb({ links: [{ item_id: "MLB1", sku_id: "sku-1" }] });
    const { client, requests } = fakeMercadoLivreClient(
      { MLB1: { id: "MLB1", inventory_id: "INV-1" } },
      { "INV-1": { inventory_id: "INV-1", available_quantity: 7 } },
    );

    const result = await fetchFulfillmentSnapshots(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 1, itemsSkipped: 0, itemsFailed: 0 });
    const snapshot = inserted.find((e) => e.table === "fulfillment_stock_snapshots")?.row;
    expect(snapshot).toMatchObject({
      organization_id: ORGANIZATION_ID,
      ml_account_id: ML_ACCOUNT_ID,
      inventory_id: "INV-1",
      item_id: "MLB1",
      variation_id: null,
      sku_id: "sku-1",
      quantity: 7,
      captured_at: CAPTURED_AT.toISOString(),
    });
    expect(requests.map((r) => r.path)).toEqual(["/items/MLB1", "/inventories/INV-1/stock/fulfillment"]);
  });

  it("primeira captura vista: emite listing.fulfillment.entered em domain_events", async () => {
    const { db, inserted } = fakeDb({ links: [{ item_id: "MLB1", sku_id: "sku-1" }] });
    const { client } = fakeMercadoLivreClient(
      { MLB1: { id: "MLB1", inventory_id: "INV-1" } },
      { "INV-1": { inventory_id: "INV-1", available_quantity: 7 } },
    );

    await fetchFulfillmentSnapshots(baseParams(db, client));

    const event = inserted.find((e) => e.table === "domain_events")?.row;
    expect(event).toMatchObject({ event_type: "listing.fulfillment.entered", entity_id: "INV-1" });
  });

  it("captura anterior com saldo positivo, atual também positivo: nenhum evento", async () => {
    const { db, inserted } = fakeDbWithPrevious(
      [{ item_id: "MLB1", sku_id: "sku-1" }],
      { "INV-1": { quantity: 10, captured_at: "2026-08-21T14:00:00.000Z" } },
    );
    const { client } = fakeMercadoLivreClient(
      { MLB1: { id: "MLB1", inventory_id: "INV-1" } },
      { "INV-1": { inventory_id: "INV-1", available_quantity: 3 } },
    );

    await fetchFulfillmentSnapshots(baseParams(db, client));

    expect(inserted.find((e) => e.table === "domain_events")).toBeUndefined();
  });

  it("captura anterior positiva, atual zerada: emite stock.depleted", async () => {
    const { db, inserted } = fakeDbWithPrevious(
      [{ item_id: "MLB1", sku_id: "sku-1" }],
      { "INV-1": { quantity: 5, captured_at: "2026-08-21T14:00:00.000Z" } },
    );
    const { client } = fakeMercadoLivreClient(
      { MLB1: { id: "MLB1", inventory_id: "INV-1" } },
      { "INV-1": { inventory_id: "INV-1", available_quantity: 0 } },
    );

    await fetchFulfillmentSnapshots(baseParams(db, client));

    const event = inserted.find((e) => e.table === "domain_events")?.row;
    expect(event).toMatchObject({ event_type: "stock.depleted", entity_id: "sku-1" });
  });

  it("percorre múltiplos vínculos, um item por vez", async () => {
    const { db, inserted } = fakeDb({
      links: [
        { item_id: "MLB1", sku_id: "sku-1" },
        { item_id: "MLB2", sku_id: "sku-2" },
      ],
    });
    const { client } = fakeMercadoLivreClient(
      {
        MLB1: { id: "MLB1", inventory_id: "INV-1" },
        MLB2: { id: "MLB2", inventory_id: "INV-2" },
      },
      {
        "INV-1": { inventory_id: "INV-1", available_quantity: 1 },
        "INV-2": { inventory_id: "INV-2", available_quantity: 2 },
      },
    );

    const result = await fetchFulfillmentSnapshots(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 2, itemsSkipped: 0, itemsFailed: 0 });
    const snapshots = inserted.filter((e) => e.table === "fulfillment_stock_snapshots").map((e) => e.row.sku_id);
    expect(snapshots).toEqual(["sku-1", "sku-2"]);
  });

  it("item sem item_id (defesa, não deveria acontecer) é ignorado sem crashar", async () => {
    const { db } = fakeDb({ links: [{ item_id: null, sku_id: "sku-1" }] });
    const { client, requests } = fakeMercadoLivreClient({}, {});

    const result = await fetchFulfillmentSnapshots(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 0, itemsSkipped: 0, itemsFailed: 0 });
    expect(requests).toHaveLength(0);
  });

  // Achado em produção (2026-08-22, primeiro disparo real do job): um
  // vínculo em sku_listing_links apontando para um anúncio removido/pausado
  // no Mercado Livre faz GET /items/{item_id} devolver 404. Sem o try/catch
  // por item, essa exceção derrubava a captura da conta INTEIRA — nenhum
  // outro item era processado, nem nas tentativas seguintes (o mesmo item
  // quebra de novo). Os testes abaixo travam esse comportamento.
  describe("erro do Mercado Livre em um item específico (achado em produção)", () => {
    it("404 ao buscar /items/{id} (anúncio removido): pula só esse item, processa os demais", async () => {
      const { db, inserted } = fakeDb({
        links: [
          { item_id: "MLB-removido", sku_id: "sku-1" },
          { item_id: "MLB2", sku_id: "sku-2" },
        ],
      });
      const requests: RequestOptions<unknown>[] = [];
      const client = {
        request: (options: RequestOptions<unknown>) => {
          requests.push(options);

          if (options.path === "/items/MLB-removido") {
            return Promise.reject(
              new MercadoLivreApiError("Mercado Livre respondeu 404 para GET /items/MLB-removido.", {
                status: 404,
                errorClass: "not_retryable",
                url: "x",
              }),
            );
          }

          if (options.path === "/items/MLB2") {
            return Promise.resolve({ id: "MLB2", inventory_id: "INV-2" });
          }

          return Promise.resolve({ inventory_id: "INV-2", available_quantity: 5 });
        },
      } as unknown as MercadoLivreClient;

      const result = await fetchFulfillmentSnapshots(baseParams(db, client));

      expect(result).toEqual({ itemsProcessed: 1, itemsSkipped: 0, itemsFailed: 1 });
      expect(inserted.filter((e) => e.table === "fulfillment_stock_snapshots")).toHaveLength(1);
      expect(inserted[0]?.row.sku_id).toBe("sku-2");
    });

    it("404 ao buscar o estoque (item some entre a resolução do inventory_id e a consulta): pula só esse item", async () => {
      const { db, inserted } = fakeDb({ links: [{ item_id: "MLB1", sku_id: "sku-1" }] });
      const client = {
        request: (options: RequestOptions<unknown>) => {
          if (options.path === "/items/MLB1") {
            return Promise.resolve({ id: "MLB1", inventory_id: "INV-1" });
          }

          return Promise.reject(
            new MercadoLivreApiError("Mercado Livre respondeu 404 para GET /inventories/INV-1/stock/fulfillment.", {
              status: 404,
              errorClass: "not_retryable",
              url: "x",
            }),
          );
        },
      } as unknown as MercadoLivreClient;

      const result = await fetchFulfillmentSnapshots(baseParams(db, client));

      expect(result).toEqual({ itemsProcessed: 0, itemsSkipped: 0, itemsFailed: 1 });
      expect(inserted.find((e) => e.table === "fulfillment_stock_snapshots")).toBeUndefined();
    });

    it("erro RETRYABLE (ex.: 503) num item propaga — não é engolido como itemsFailed", async () => {
      const { db } = fakeDb({ links: [{ item_id: "MLB1", sku_id: "sku-1" }] });
      const client = {
        request: () =>
          Promise.reject(
            new MercadoLivreApiError("indisponível", { status: 503, errorClass: "retryable", url: "x" }),
          ),
      } as unknown as MercadoLivreClient;

      await expect(fetchFulfillmentSnapshots(baseParams(db, client))).rejects.toThrow(MercadoLivreApiError);
    });
  });
});
