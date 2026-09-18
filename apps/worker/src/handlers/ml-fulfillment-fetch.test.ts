import { createLogger } from "@sb/observability";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { describe, expect, it } from "vitest";

import type { FetchFulfillmentSnapshotsParams } from "./ml-fulfillment-fetch.js";
import { fetchFulfillmentSnapshots, ITEM_ABSENCE_RECHECK_MS } from "./ml-fulfillment-fetch.js";

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
  in: () => ReturnType<typeof chain<T>>;
  is: () => ReturnType<typeof chain<T>>;
  order: () => ReturnType<typeof chain<T>>;
  limit: () => ReturnType<typeof chain<T>>;
  range: (from: number, to: number) => Promise<T>;
  maybeSingle: () => Promise<T>;
  then: <R>(resolve: (value: T) => R) => Promise<R>;
} {
  const self = {
    eq: () => self,
    in: () => self,
    is: () => self,
    order: () => self,
    limit: () => self,
    // `range` FATIA de verdade (D-131). Um fake que devolvesse a lista
    // inteira em qualquer janela não distinguiria código que pagina de
    // código que não pagina — e foi essa cegueira que deixou o truncamento
    // de `sku_listing_links` passar por seis dias em produção.
    range: (from: number, to: number) => {
      const envelope = result as { data?: unknown };

      if (Array.isArray(envelope.data)) {
        return Promise.resolve({ ...(result as object), data: envelope.data.slice(from, to + 1) } as T);
      }

      return Promise.resolve(result);
    },
    maybeSingle: () => Promise.resolve(result),
    then: <R>(resolve: (value: T) => R) => Promise.resolve(result).then(resolve),
  };

  return self;
}

function fakeDb(options: {
  links?: Link[];
  linksError?: boolean;
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
          return chain(
            options.linksError === true ? { data: null, error: { message: "boom" } } : { data: links, error: null },
          );
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
      // upsert espelha insert: domain_events/stock_movements passaram a
      // gravar por ON CONFLICT DO NOTHING (D-092).
      upsert: (row: Record<string, unknown>) => {
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
    in: (col: string, vals: readonly unknown[]) => ReturnType<typeof snapshotFilterChain>;
    order: () => ReturnType<typeof snapshotFilterChain>;
    limit: () => ReturnType<typeof snapshotFilterChain>;
    range: (from: number, to: number) => Promise<{ data: PreviousSnapshot[]; error: null }>;
    maybeSingle: () => Promise<{ data: unknown; error: null }>;
  } {
    const self = {
      eq: (col: string, val: unknown) => snapshotFilterChain({ ...filters, [col]: val }),
      in: (col: string, vals: readonly unknown[]) => snapshotFilterChain({ ...filters, [col]: vals }),
      order: () => self,
      limit: () => self,
      range: (from: number, to: number) => {
        const ids = (filters.inventory_id as readonly string[] | undefined) ?? [];
        const rows = ids.flatMap((id) => {
          const row = previousByInventoryId[id];
          return row === undefined ? [] : [{ ...row, inventory_id: id }];
        });
        return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
      },
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
      // upsert espelha insert: domain_events/stock_movements passaram a
      // gravar por ON CONFLICT DO NOTHING (D-092).
      upsert: (row: Record<string, unknown>) => {
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

    expect(result).toEqual({ itemsProcessed: 0, itemsSkipped: 0, itemsFailed: 0, itemsDeferred: 0, inventoriesShared: 0 });
    expect(requests).toHaveLength(0);
  });

  it("item nunca enviado ao Full (inventory_id nulo): conta como skipped, não grava snapshot", async () => {
    const { db, inserted } = fakeDb({ links: [{ item_id: "MLB1", sku_id: "sku-1" }] });
    const { client } = fakeMercadoLivreClient({ MLB1: { id: "MLB1", inventory_id: null } }, {});

    const result = await fetchFulfillmentSnapshots(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 0, itemsSkipped: 1, itemsFailed: 0, itemsDeferred: 0, inventoriesShared: 0 });
    expect(inserted.find((e) => e.table === "fulfillment_stock_snapshots")).toBeUndefined();
  });

  it("item no Full: grava snapshot com available_quantity e a chave certa", async () => {
    const { db, inserted } = fakeDb({ links: [{ item_id: "MLB1", sku_id: "sku-1" }] });
    const { client, requests } = fakeMercadoLivreClient(
      { MLB1: { id: "MLB1", inventory_id: "INV-1" } },
      { "INV-1": { inventory_id: "INV-1", available_quantity: 7 } },
    );

    const result = await fetchFulfillmentSnapshots(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 1, itemsSkipped: 0, itemsFailed: 0, itemsDeferred: 0, inventoriesShared: 0 });
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

    expect(result).toEqual({ itemsProcessed: 2, itemsSkipped: 0, itemsFailed: 0, itemsDeferred: 0, inventoriesShared: 0 });
    const snapshots = inserted.filter((e) => e.table === "fulfillment_stock_snapshots").map((e) => e.row.sku_id);
    expect(snapshots).toEqual(["sku-1", "sku-2"]);
  });

  it("dois anúncios com o MESMO inventory_id: um snapshot só, uma chamada de estoque só, e a captura não cai (D-230)", async () => {
    // O que aconteceu em produção em 02/09/2026 21:00: dois vínculos da mesma
    // conta resolvem para o mesmo `inventory_id` (o inventário é do PRODUTO
    // do vendedor, e um user product vive em vários anúncios). A segunda
    // gravação colidia com a chave única (ml_account_id, inventory_id,
    // captured_at); desde D-178 isso abortava a captura da conta inteira —
    // 4 contas, 8 tentativas, 32 falhas, 18 horas sem snapshot.
    //
    // O fake de banco nunca recusa um insert, então este teste NÃO passa por
    // acaso no código antigo: lá saem DUAS linhas e DUAS chamadas de estoque.
    const { db, inserted } = fakeDb({
      links: [
        { item_id: "MLB1", sku_id: "sku-1" },
        { item_id: "MLB2", sku_id: "sku-2" },
      ],
    });
    const { client, requests } = fakeMercadoLivreClient(
      { MLB1: { id: "MLB1", inventory_id: "INV-COMPARTILHADO" }, MLB2: { id: "MLB2", inventory_id: "INV-COMPARTILHADO" } },
      { "INV-COMPARTILHADO": { inventory_id: "INV-COMPARTILHADO", available_quantity: 9 } },
    );
    const lines: string[] = [];

    const result = await fetchFulfillmentSnapshots(baseParams(db, client, lines));

    expect(result).toEqual({ itemsProcessed: 1, itemsSkipped: 0, itemsFailed: 0, itemsDeferred: 0, inventoriesShared: 1 });

    const snapshots = inserted.filter((entry) => entry.table === "fulfillment_stock_snapshots");

    // UMA linha, a do primeiro anúncio em ordem de item_id — grão por
    // inventário (D-173), nunca por anúncio.
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.row).toMatchObject({ item_id: "MLB1", inventory_id: "INV-COMPARTILHADO", quantity: 9 });

    // Dois GET /items (um por vínculo), mas UM só GET de estoque: o segundo
    // anúncio é reconhecido antes da chamada.
    expect(requests.filter((r) => r.path.startsWith("/items/"))).toHaveLength(2);
    expect(requests.filter((r) => r.path.includes("/stock/fulfillment"))).toHaveLength(1);

    // O log diz QUAL anúncio repetiu qual, e se apontam para o mesmo SKU —
    // aqui não: é o caso que quem cuida dos vínculos precisa ver.
    const log = lines.find((line) => line.includes("fulfillment_inventory_shared"));
    expect(log).toBeDefined();
    expect(log).toContain('"item_id":"MLB2"');
    expect(log).toContain('"first_item_id":"MLB1"');
    expect(log).toContain('"same_sku":false');
  });

  it("item sem item_id (defesa, não deveria acontecer) é ignorado sem crashar", async () => {
    const { db } = fakeDb({ links: [{ item_id: null, sku_id: "sku-1" }] });
    const { client, requests } = fakeMercadoLivreClient({}, {});

    const result = await fetchFulfillmentSnapshots(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 0, itemsSkipped: 0, itemsFailed: 0, itemsDeferred: 0, inventoriesShared: 0 });
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

      expect(result).toEqual({ itemsProcessed: 1, itemsSkipped: 0, itemsFailed: 1, itemsDeferred: 0, inventoriesShared: 0 });
      expect(inserted.filter((e) => e.table === "fulfillment_stock_snapshots")).toHaveLength(1);
      // Filtrado por tabela: desde a marca de ausência o 404 também grava em
      // `fulfillment_item_absences`, e a primeira escrita já não é o snapshot.
      expect(inserted.find((e) => e.table === "fulfillment_stock_snapshots")?.row.sku_id).toBe("sku-2");
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

      expect(result).toEqual({ itemsProcessed: 0, itemsSkipped: 0, itemsFailed: 1, itemsDeferred: 0, inventoriesShared: 0 });
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

  it("falha ao ler sku_listing_links rejeita — sem isto viraria 'done, 0 processados', igual a uma conta sem anúncio", async () => {
    const { db } = fakeDb({ linksError: true });
    const { client } = fakeMercadoLivreClient({}, {});

    await expect(fetchFulfillmentSnapshots(baseParams(db, client))).rejects.toThrow(/sku_listing_links/);
  });
  it("conta com mais de 1.000 vínculos é lida INTEIRA — o teto do PostgREST escondia metade do Full (D-131)", async () => {
    // 2.012 é o número real da conta "Speedbikers (loja 1)" em 2026-08-28.
    // Sem paginação o handler consultava 1.000 e ia embora: os outros 1.012
    // anúncios nunca eram perguntados ao Mercado Livre, e o snapshot do Full
    // vinha pela metade sem nenhum erro para denunciar.
    const links = Array.from({ length: 2012 }, (_, i) => ({
      item_id: `MLB${String(i).padStart(5, "0")}`,
      sku_id: `sku-${String(i)}`,
    }));

    const itens = Object.fromEntries(links.map((l) => [l.item_id, { id: l.item_id, inventory_id: null }]));

    const { db } = fakeDb({ links });
    const { client, requests } = fakeMercadoLivreClient(itens, {});

    const result = await fetchFulfillmentSnapshots(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 0, itemsSkipped: 2012, itemsFailed: 0, itemsDeferred: 0, inventoriesShared: 0 });
    expect(requests).toHaveLength(2012);
  });
});

// ============================================================
// Marca de ausência (fulfillment_item_absences) — o anúncio que respondeu
// 404/403 sai da varredura até o recheque.
//
// Medido em produção de 15/09 a 18/09: os mesmos 356 anúncios responderam
// 404 em 14 das 15 execuções (a outra foi 403 em todos os itens). Os testes
// abaixo usam um banco fake COM
// ESTADO para a tabela de marcas: o `upsert` de uma execução é o que a
// execução seguinte lê. Assim "grava a marca" e "pula o item depois" são
// afirmados pelo efeito, não pela forma da chamada.
// ============================================================

interface AbsenceRow {
  organization_id: string;
  ml_account_id: string;
  item_id: string;
  http_status: number;
  failures: number;
  first_failed_at: string;
  last_failed_at: string;
  recheck_after: string;
}

type ItemBehavior = { id: string; inventory_id: string | null } | { status: number };

const HOUR = 3_600_000;
const T0 = new Date("2026-09-18T09:00:05.000Z");

function at(hoursAfterT0: number): Date {
  return new Date(T0.getTime() + hoursAfterT0 * HOUR);
}

function fakeDbWithAbsences(options: {
  links: Link[];
  absences?: AbsenceRow[];
  readError?: boolean;
  upsertError?: boolean;
  deleteError?: boolean;
}): {
  db: FetchFulfillmentSnapshotsParams["db"];
  table: Map<string, AbsenceRow>;
  upserts: { rows: AbsenceRow[]; options: unknown }[];
  deletes: { filters: Record<string, unknown>; ids: readonly string[] }[];
  inserted: { table: string; row: unknown }[];
} {
  const table = new Map<string, AbsenceRow>((options.absences ?? []).map((row) => [row.item_id, row]));
  const upserts: { rows: AbsenceRow[]; options: unknown }[] = [];
  const deletes: { filters: Record<string, unknown>; ids: readonly string[] }[] = [];
  const inserted: { table: string; row: unknown }[] = [];
  const ok = { data: null, error: null };
  const boom = { data: null, error: { message: "boom" } };

  const db = {
    from: (name: string) => ({
      select: () => {
        if (name === "sku_listing_links") {
          return chain({ data: options.links, error: null });
        }

        if (name === "fulfillment_item_absences") {
          if (options.readError === true) {
            return chain({ data: null, error: { message: 'relation "fulfillment_item_absences" does not exist' } });
          }

          const rows = [...table.values()].sort((a, b) => a.item_id.localeCompare(b.item_id));

          return chain({ data: rows, error: null });
        }

        return chain({ data: [], error: null });
      },
      insert: (row: unknown) => {
        inserted.push({ table: name, row });

        return Promise.resolve(ok);
      },
      upsert: (rows: unknown, upsertOptions?: unknown) => {
        if (name !== "fulfillment_item_absences") {
          inserted.push({ table: name, row: rows });

          return Promise.resolve(ok);
        }

        upserts.push({ rows: rows as AbsenceRow[], options: upsertOptions });

        if (options.upsertError === true) return Promise.resolve(boom);

        for (const row of rows as AbsenceRow[]) table.set(row.item_id, row);

        return Promise.resolve(ok);
      },
      delete: () => {
        const filters: Record<string, unknown> = {};
        const builder = {
          eq: (column: string, value: unknown) => {
            filters[column] = value;

            return builder;
          },
          in: (_column: string, ids: readonly string[]) => {
            deletes.push({ filters: { ...filters }, ids });

            if (options.deleteError === true) return Promise.resolve(boom);

            if (filters.ml_account_id === ML_ACCOUNT_ID) {
              for (const id of ids) table.delete(id);
            }

            return Promise.resolve(ok);
          },
        };

        return builder;
      },
    }),
  } as unknown as FetchFulfillmentSnapshotsParams["db"];

  return { db, table, upserts, deletes, inserted };
}

function scriptedClient(
  behavior: Record<string, ItemBehavior>,
  stock: Record<string, number> = {},
): { client: MercadoLivreClient; itemRequests: () => string[] } {
  const requests: string[] = [];

  const client = {
    request: (options: RequestOptions<unknown>) => {
      requests.push(options.path);

      const itemMatch = /^\/items\/(.+)$/.exec(options.path);

      if (itemMatch?.[1] !== undefined) {
        const entry = behavior[itemMatch[1]] ?? { id: itemMatch[1], inventory_id: null };

        if ("status" in entry) {
          return Promise.reject(
            new MercadoLivreApiError(`Mercado Livre respondeu ${String(entry.status)} para GET ${options.path}.`, {
              status: entry.status,
              errorClass: "not_retryable",
              url: options.path,
            }),
          );
        }

        return Promise.resolve(entry);
      }

      const stockMatch = /^\/inventories\/(.+)\/stock\/fulfillment$/.exec(options.path);

      if (stockMatch?.[1] !== undefined) {
        return Promise.resolve({ inventory_id: stockMatch[1], available_quantity: stock[stockMatch[1]] ?? 1 });
      }

      throw new Error(`caminho inesperado no fake: ${options.path}`);
    },
  } as unknown as MercadoLivreClient;

  return { client, itemRequests: () => requests.filter((path) => path.startsWith("/items/")) };
}

function runAt(
  db: FetchFulfillmentSnapshotsParams["db"],
  client: MercadoLivreClient,
  when: Date,
  lines: string[] = [],
): ReturnType<typeof fetchFulfillmentSnapshots> {
  return fetchFulfillmentSnapshots({ ...baseParams(db, client, lines), now: () => when });
}

/** Um anúncio morto no meio de dois vivos: 1 falha em 3 consultas, longe da regra de falha em massa. */
const LINKS_COM_UM_MORTO: Link[] = [
  { item_id: "MLB1", sku_id: "sku-1" },
  { item_id: "MLB2", sku_id: "sku-2" },
  { item_id: "MLB9", sku_id: "sku-9" },
];

const VIVOS: Record<string, ItemBehavior> = {
  MLB1: { id: "MLB1", inventory_id: "INV-1" },
  MLB2: { id: "MLB2", inventory_id: "INV-2" },
};

function mark(itemId: string, status: number, recheckAfter: Date, extra: Partial<AbsenceRow> = {}): AbsenceRow {
  return {
    organization_id: ORGANIZATION_ID,
    ml_account_id: ML_ACCOUNT_ID,
    item_id: itemId,
    http_status: status,
    failures: 1,
    first_failed_at: T0.toISOString(),
    last_failed_at: T0.toISOString(),
    recheck_after: recheckAfter.toISOString(),
    ...extra,
  };
}

describe("marca de ausência: item 404/403 sai da varredura até o recheque", () => {
  it("as janelas: 403 pula uma execução de 6 h, 404 pula sete e cabe na janela de 3 dias do Full atual (D-173)", () => {
    // 403: vence entre a 1ª (6 h) e a 2ª (12 h) execução seguinte.
    expect(ITEM_ABSENCE_RECHECK_MS[403]).toBeGreaterThan(6 * HOUR);
    expect(ITEM_ABSENCE_RECHECK_MS[403]).toBeLessThan(12 * HOUR);
    // 404: vence entre 42 h e 48 h — recheque na oitava execução.
    expect(ITEM_ABSENCE_RECHECK_MS[404]).toBeGreaterThan(42 * HOUR);
    expect(ITEM_ABSENCE_RECHECK_MS[404]).toBeLessThan(48 * HOUR);
    // Último snapshot bom (até 6 h antes da falha) + próxima execução depois
    // da janela precisa caber nas 72 h do Full atual: senão um 404 falso
    // tiraria o bucket das telas antes do recheque.
    expect(6 * HOUR + ITEM_ABSENCE_RECHECK_MS[404] + 6 * HOUR).toBeLessThan(72 * HOUR);
  });

  it("404 grava a marca e o item é PULADO nas execuções seguintes, até a janela vencer", async () => {
    const state = fakeDbWithAbsences({ links: LINKS_COM_UM_MORTO });
    const { client, itemRequests } = scriptedClient({ ...VIVOS, MLB9: { status: 404 } });

    const first = await runAt(state.db, client, T0);

    expect(first).toEqual({ itemsProcessed: 2, itemsSkipped: 0, itemsFailed: 1, itemsDeferred: 0, inventoriesShared: 0 });
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]?.options).toEqual({ onConflict: "ml_account_id,item_id" });
    expect(state.table.get("MLB9")).toEqual({
      organization_id: ORGANIZATION_ID,
      ml_account_id: ML_ACCOUNT_ID,
      item_id: "MLB9",
      http_status: 404,
      failures: 1,
      first_failed_at: T0.toISOString(),
      last_failed_at: T0.toISOString(),
      recheck_after: new Date(T0.getTime() + ITEM_ABSENCE_RECHECK_MS[404]).toISOString(),
    });
    // Só o morto ganha marca.
    expect([...state.table.keys()]).toEqual(["MLB9"]);

    // Sete execuções seguintes (6 h a 42 h): o morto não é consultado, os
    // vivos são. Nenhuma marca nova, nenhuma apagada.
    for (const hours of [6, 12, 18, 24, 30, 36, 42]) {
      const before = itemRequests().length;
      const result = await runAt(state.db, client, at(hours));

      expect(result).toEqual({ itemsProcessed: 2, itemsSkipped: 0, itemsFailed: 0, itemsDeferred: 1, inventoriesShared: 0 });
      expect(itemRequests().slice(before).sort()).toEqual(["/items/MLB1", "/items/MLB2"]);
    }

    expect(state.upserts).toHaveLength(1);
    expect(state.deletes).toHaveLength(0);
  });

  it("403 grava marca de janela CURTA: pula a execução de +6 h e volta a perguntar na de +12 h", async () => {
    const state = fakeDbWithAbsences({ links: LINKS_COM_UM_MORTO });
    const { client, itemRequests } = scriptedClient({ ...VIVOS, MLB9: { status: 403 } });

    await runAt(state.db, client, T0);

    expect(state.table.get("MLB9")).toMatchObject({
      http_status: 403,
      recheck_after: new Date(T0.getTime() + ITEM_ABSENCE_RECHECK_MS[403]).toISOString(),
    });

    const six = await runAt(state.db, client, at(6));

    expect(six.itemsDeferred).toBe(1);
    // Uma consulta só ao morto até aqui: a da execução que gravou a marca.
    expect(itemRequests().filter((path) => path === "/items/MLB9")).toHaveLength(1);

    const twelve = await runAt(state.db, client, at(12));

    expect(twelve.itemsDeferred).toBe(0);
    expect(twelve.itemsFailed).toBe(1);
    expect(itemRequests().filter((path) => path === "/items/MLB9")).toHaveLength(2);
  });

  it("recheque vencido volta a buscar; 404 de novo RENOVA a marca, conta a falha e preserva first_failed_at", async () => {
    const state = fakeDbWithAbsences({
      links: LINKS_COM_UM_MORTO,
      absences: [mark("MLB9", 404, at(45))],
    });
    const { client, itemRequests } = scriptedClient({ ...VIVOS, MLB9: { status: 404 } });

    const result = await runAt(state.db, client, at(48));

    expect(result.itemsDeferred).toBe(0);
    expect(result.itemsFailed).toBe(1);
    expect(itemRequests()).toContain("/items/MLB9");
    expect(state.table.get("MLB9")).toMatchObject({
      http_status: 404,
      failures: 2,
      first_failed_at: T0.toISOString(),
      last_failed_at: at(48).toISOString(),
      recheck_after: new Date(at(48).getTime() + ITEM_ABSENCE_RECHECK_MS[404]).toISOString(),
    });
  });

  it("marca que vence EXATAMENTE agora já não segura o item", async () => {
    const state = fakeDbWithAbsences({ links: LINKS_COM_UM_MORTO, absences: [mark("MLB9", 403, at(9))] });
    const { client, itemRequests } = scriptedClient({ ...VIVOS, MLB9: { status: 403 } });

    const result = await runAt(state.db, client, at(9));

    expect(result.itemsDeferred).toBe(0);
    expect(itemRequests()).toContain("/items/MLB9");
  });

  it("sucesso depois da marca vencida APAGA a marca e o item volta ao snapshot", async () => {
    const state = fakeDbWithAbsences({ links: LINKS_COM_UM_MORTO, absences: [mark("MLB9", 403, at(9))] });
    const { client } = scriptedClient({ ...VIVOS, MLB9: { id: "MLB9", inventory_id: "INV-9" } }, { "INV-9": 4 });
    const lines: string[] = [];

    const result = await runAt(state.db, client, at(12), lines);

    expect(result).toEqual({ itemsProcessed: 3, itemsSkipped: 0, itemsFailed: 0, itemsDeferred: 0, inventoriesShared: 0 });
    expect(state.table.size).toBe(0);
    expect(state.deletes).toEqual([{ filters: { ml_account_id: ML_ACCOUNT_ID }, ids: ["MLB9"] }]);
    expect(state.upserts).toHaveLength(0);
    expect(
      state.inserted.filter((entry) => entry.table === "fulfillment_stock_snapshots").map((entry) => (entry.row as { item_id: string }).item_id),
    ).toContain("MLB9");
    expect(lines.find((line) => line.includes("fulfillment_item_absences_updated"))).toContain('"cleared":1');
  });

  it("item sem Full (inventory_id nulo) também é sucesso: a marca sai", async () => {
    const state = fakeDbWithAbsences({ links: LINKS_COM_UM_MORTO, absences: [mark("MLB9", 404, at(45))] });
    const { client } = scriptedClient({ ...VIVOS, MLB9: { id: "MLB9", inventory_id: null } });

    const result = await runAt(state.db, client, at(48));

    expect(result.itemsSkipped).toBe(1);
    expect(state.table.size).toBe(0);
  });

  it("falha em MASSA (mais da metade das consultas) não grava marca nenhuma — 16/09 21:00", async () => {
    // As quatro contas tomaram 403 em TODOS os itens de uma vez, e a
    // execução seguinte capturou normal. Marcar ali pularia a execução boa.
    const state = fakeDbWithAbsences({ links: LINKS_COM_UM_MORTO });
    const { client, itemRequests } = scriptedClient({ MLB1: { status: 403 }, MLB2: { status: 403 }, MLB9: { status: 403 } });
    const lines: string[] = [];

    const result = await runAt(state.db, client, T0, lines);

    expect(result).toEqual({ itemsProcessed: 0, itemsSkipped: 0, itemsFailed: 3, itemsDeferred: 0, inventoriesShared: 0 });
    expect(state.upserts).toHaveLength(0);
    expect(state.table.size).toBe(0);
    expect(lines.find((line) => line.includes("fulfillment_item_absences_skipped_mass_failure"))).toContain('"items_failed":3');

    // A execução seguinte pergunta tudo de novo.
    await runAt(state.db, client, at(6));

    expect(itemRequests()).toHaveLength(6);
  });

  it("metade EXATA ainda é falha de item, não de massa: a marca é gravada", async () => {
    const state = fakeDbWithAbsences({
      links: [
        { item_id: "MLB1", sku_id: "sku-1" },
        { item_id: "MLB9", sku_id: "sku-9" },
      ],
    });
    const { client } = scriptedClient({ MLB1: { id: "MLB1", inventory_id: "INV-1" }, MLB9: { status: 404 } });

    await runAt(state.db, client, T0);

    expect([...state.table.keys()]).toEqual(["MLB9"]);
  });

  it("outro erro não retryable (401) conta como falha mas NÃO vira marca — é da conta, não do item", async () => {
    const state = fakeDbWithAbsences({ links: LINKS_COM_UM_MORTO });
    const { client } = scriptedClient({ ...VIVOS, MLB9: { status: 401 } });

    const result = await runAt(state.db, client, T0);

    expect(result.itemsFailed).toBe(1);
    expect(state.upserts).toHaveLength(0);
  });

  it("marca de outro anúncio não afeta este: só o item marcado é pulado", async () => {
    const state = fakeDbWithAbsences({ links: LINKS_COM_UM_MORTO, absences: [mark("MLB9", 404, at(45))] });
    const { client, itemRequests } = scriptedClient({ ...VIVOS, MLB9: { status: 404 } });

    await runAt(state.db, client, at(6));

    expect(itemRequests().sort()).toEqual(["/items/MLB1", "/items/MLB2"]);
  });

  it("leitura das marcas falhou (ou migration ainda não aplicada): busca TODOS os itens e avisa", async () => {
    const state = fakeDbWithAbsences({ links: LINKS_COM_UM_MORTO, absences: [mark("MLB9", 404, at(45))], readError: true });
    const { client, itemRequests } = scriptedClient({ ...VIVOS, MLB9: { status: 404 } });
    const lines: string[] = [];

    const result = await runAt(state.db, client, at(6), lines);

    expect(result.itemsDeferred).toBe(0);
    expect(result.itemsProcessed).toBe(2);
    expect(itemRequests()).toHaveLength(3);
    expect(lines.find((line) => line.includes("fulfillment_item_absences_unreadable"))).toBeDefined();
  });

  it("escrita da marca falhou: a captura termina igual, só avisa", async () => {
    const state = fakeDbWithAbsences({ links: LINKS_COM_UM_MORTO, upsertError: true });
    const { client } = scriptedClient({ ...VIVOS, MLB9: { status: 404 } });
    const lines: string[] = [];

    const result = await runAt(state.db, client, T0, lines);

    expect(result).toEqual({ itemsProcessed: 2, itemsSkipped: 0, itemsFailed: 1, itemsDeferred: 0, inventoriesShared: 0 });
    expect(lines.find((line) => line.includes("fulfillment_item_absences_not_recorded"))).toBeDefined();
  });

  it("apagar a marca falhou: a captura termina igual, só avisa", async () => {
    const state = fakeDbWithAbsences({ links: LINKS_COM_UM_MORTO, absences: [mark("MLB9", 403, at(9))], deleteError: true });
    const { client } = scriptedClient({ ...VIVOS, MLB9: { id: "MLB9", inventory_id: "INV-9" } });
    const lines: string[] = [];

    const result = await runAt(state.db, client, at(12), lines);

    expect(result.itemsProcessed).toBe(3);
    expect(lines.find((line) => line.includes("fulfillment_item_absences_not_cleared"))).toBeDefined();
  });

  it("muitos itens voltando de uma vez são apagados em lotes de 100 (o .in() vai na URL)", async () => {
    const links = Array.from({ length: 250 }, (_, i) => ({ item_id: `MLB${String(1000 + i)}`, sku_id: `sku-${String(i)}` }));
    const state = fakeDbWithAbsences({
      links,
      absences: links.map((link) => mark(link.item_id, 403, at(9))),
    });
    const { client } = scriptedClient({});

    await runAt(state.db, client, at(12));

    expect(state.deletes.map((entry) => entry.ids.length)).toEqual([100, 100, 50]);
    expect(state.table.size).toBe(0);
  });
});
