import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { FetchListingsParams } from "./ml-listings-fetch.js";
import { fetchListings } from "./ml-listings-fetch.js";

const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SELLER_ID = 118570204;
const SYNCED_AT = new Date("2026-08-28T18:00:00.000Z");

interface Link {
  item_id: string | null;
  sku_id: string;
}

interface PreviousRow {
  item_id: string;
  title: string;
  status: string;
  price: number;
  available_quantity: number;
}

/** Fake encadeável: `.eq()`/`.is()` devolvem a si mesmos e o `await` resolve. */
function chain<T>(result: T): T {
  const self = {
    eq: () => self,
    is: () => self,
    then: (resolve: (value: T) => unknown) => Promise.resolve(result).then(resolve),
  };

  return self as unknown as T;
}

function fakeDb(options: {
  links?: Link[];
  previous?: PreviousRow[];
  linksError?: boolean;
  previousError?: boolean;
  upsertFails?: boolean;
}): {
  db: FetchListingsParams["db"];
  upserted: Record<string, unknown>[];
  domainEvents: Record<string, unknown>[];
} {
  const upserted: Record<string, unknown>[] = [];
  const domainEvents: Record<string, unknown>[] = [];

  const db = {
    from: (table: string) => ({
      select: () => {
        if (table === "sku_listing_links") {
          return chain(
            options.linksError === true
              ? { data: null, error: { message: "boom links" } }
              : { data: options.links ?? [], error: null },
          );
        }

        if (table === "listings") {
          return chain(
            options.previousError === true
              ? { data: null, error: { message: "boom previous" } }
              : { data: options.previous ?? [], error: null },
          );
        }

        throw new Error(`select inesperado em ${table}`);
      },
      upsert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        if (table === "domain_events") {
          domainEvents.push(rows as Record<string, unknown>);

          return Promise.resolve({ data: null, error: null });
        }

        for (const row of Array.isArray(rows) ? rows : [rows]) {
          upserted.push(row);
        }

        return Promise.resolve(
          options.upsertFails === true
            ? { data: null, error: { message: "boom upsert" } }
            : { data: null, error: null },
        );
      },
    }),
  } as unknown as FetchListingsParams["db"];

  return { db, upserted, domainEvents };
}

function item(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Anúncio ${id}`,
    status: "active",
    price: 100,
    currency_id: "BRL",
    available_quantity: 5,
    category_id: "MLB1234",
    ...overrides,
  };
}

/**
 * Fake do Mercado Livre com as DUAS fases reais: a varredura devolve páginas
 * de IDs, o multiget devolve o envelope verbose.
 */
function fakeClient(options: {
  scanPages: { results: string[]; scroll_id?: string | null }[];
  bodies?: Record<string, Record<string, unknown>>;
  codes?: Record<string, number>;
}): { client: MercadoLivreClient; requests: RequestOptions<unknown>[] } {
  const requests: RequestOptions<unknown>[] = [];
  let scanIndex = 0;

  const client = {
    request: (request: RequestOptions<unknown>) => {
      requests.push(request);

      if (request.path.endsWith("/items/search")) {
        const page = options.scanPages[scanIndex] ?? { results: [], scroll_id: null };
        scanIndex += 1;

        return Promise.resolve(request.schema.parse(page));
      }

      if (request.path === "/items") {
        const ids = String(request.searchParams?.ids ?? "").split(",").filter(Boolean);
        const entries = ids.map((id) => ({
          code: options.codes?.[id] ?? 200,
          body: options.bodies?.[id] ?? item(id),
        }));

        return Promise.resolve(request.schema.parse(entries));
      }

      throw new Error(`chamada inesperada: ${request.path}`);
    },
  } as unknown as MercadoLivreClient;

  return { client, requests };
}

function params(
  db: FetchListingsParams["db"],
  client: MercadoLivreClient,
): FetchListingsParams {
  return {
    db,
    organizationId: ORGANIZATION_ID,
    mlAccountId: ML_ACCOUNT_ID,
    sellerId: SELLER_ID,
    mercadoLivre: client,
    accessToken: "token",
    logger: createLogger({}, { sink: () => undefined }),
    now: () => SYNCED_AT,
  };
}

describe("fetchListings — enumeração pelo catálogo real (Fase 4B)", () => {
  it("enumera o CATÁLOGO, não os vínculos — anúncio sem vínculo entra com sku_id nulo", async () => {
    // O ponto inteiro da Fase 4B: a versão anterior enumerava
    // `sku_listing_links` e por isso não sabia que MLB2 existia.
    const fake = fakeDb({ links: [{ item_id: "MLB1", sku_id: "sku-1" }] });
    const { client } = fakeClient({ scanPages: [{ results: ["MLB1", "MLB2"], scroll_id: null }] });

    const result = await fetchListings(params(fake.db, client));

    expect(result.itemsDiscovered).toBe(2);
    expect(result.itemsProcessed).toBe(2);
    expect(result.itemsWithoutLink).toBe(1);
    expect(fake.upserted.map((row) => [row.item_id, row.sku_id])).toEqual([
      ["MLB1", "sku-1"],
      ["MLB2", null],
    ]);
  });

  it("a varredura é drenada INTEIRA antes de qualquer escrita — o scroll expira em 5 min", async () => {
    const fake = fakeDb({});
    const { client, requests } = fakeClient({
      scanPages: [
        { results: ["MLB1"], scroll_id: "s1" },
        { results: ["MLB2"], scroll_id: "s1" },
        { results: [], scroll_id: null },
      ],
    });

    await fetchListings(params(fake.db, client));

    const paths = requests.map((request) => request.path);
    const ultimaBusca = paths.lastIndexOf(`/users/${String(SELLER_ID)}/items/search`);
    const primeiroMultiget = paths.indexOf("/items");

    expect(primeiroMultiget).toBeGreaterThan(ultimaBusca);
  });

  it("hidrata em lotes de 20 — o máximo documentado do multiget", async () => {
    const ids = Array.from({ length: 45 }, (_, index) => `MLB${String(index)}`);
    const fake = fakeDb({});
    const { client, requests } = fakeClient({ scanPages: [{ results: ids, scroll_id: null }] });

    const result = await fetchListings(params(fake.db, client));

    const multigets = requests.filter((request) => request.path === "/items");

    expect(multigets).toHaveLength(3);
    expect(String(multigets[0]?.searchParams?.ids).split(",")).toHaveLength(20);
    expect(result.itemsProcessed).toBe(45);
  });

  it("code != 200 é falha POR ITEM: o lote continua, o resto entra", async () => {
    const fake = fakeDb({});
    const { client } = fakeClient({
      scanPages: [{ results: ["MLB1", "MLB2"], scroll_id: null }],
      codes: { MLB2: 404 },
    });

    const result = await fetchListings(params(fake.db, client));

    expect(result.itemsFailed).toBe(1);
    expect(result.itemsProcessed).toBe(1);
    expect(fake.upserted).toHaveLength(1);
  });

  it("payload fora do schema não derruba o lote — vira itemsFailed", async () => {
    const fake = fakeDb({});
    const { client } = fakeClient({
      scanPages: [{ results: ["MLB1", "MLB2"], scroll_id: null }],
      bodies: { MLB2: { id: "MLB2", title: "sem preço" } },
    });

    const result = await fetchListings(params(fake.db, client));

    expect(result.itemsFailed).toBe(1);
    expect(result.itemsProcessed).toBe(1);
  });

  it("falha do upsert conta como falha, NUNCA como processado", async () => {
    // Sem isto, um lote perdido virava "done, N processados" — a mesma classe
    // de mentira que D-067 auditou.
    const fake = fakeDb({ upsertFails: true });
    const { client } = fakeClient({ scanPages: [{ results: ["MLB1"], scroll_id: null }] });

    const result = await fetchListings(params(fake.db, client));

    expect(result.itemsProcessed).toBe(0);
    expect(result.itemsFailed).toBe(1);
  });

  it("o motor de diff continua vivo: preço mudou gera evento", async () => {
    const fake = fakeDb({
      previous: [
        { item_id: "MLB1", title: "Anúncio MLB1", status: "active", price: 90, available_quantity: 5 },
      ],
    });
    const { client } = fakeClient({ scanPages: [{ results: ["MLB1"], scroll_id: null }] });

    await fetchListings(params(fake.db, client));

    expect(fake.domainEvents.map((event) => event.event_type)).toContain("listing.price.changed");
  });

  it("primeira sincronização (sem estado anterior) não inventa evento de mudança", async () => {
    const fake = fakeDb({});
    const { client } = fakeClient({ scanPages: [{ results: ["MLB1"], scroll_id: null }] });

    await fetchListings(params(fake.db, client));

    expect(fake.domainEvents).toHaveLength(0);
  });

  it("catálogo vazio: nada quebra e nada é gravado", async () => {
    const fake = fakeDb({});
    const { client } = fakeClient({ scanPages: [{ results: [], scroll_id: null }] });

    const result = await fetchListings(params(fake.db, client));

    expect(result).toEqual({
      itemsDiscovered: 0,
      itemsProcessed: 0,
      itemsFailed: 0,
      itemsWithoutLink: 0,
    });
    expect(fake.upserted).toHaveLength(0);
  });

  it("falha ao ler vínculos PROPAGA — não vira catálogo sem SKU nenhum", async () => {
    const fake = fakeDb({ linksError: true });
    const { client } = fakeClient({ scanPages: [{ results: ["MLB1"], scroll_id: null }] });

    await expect(fetchListings(params(fake.db, client))).rejects.toThrow(/sku_listing_links/);
  });

  it("falha ao ler o estado anterior PROPAGA — senão todo anúncio pareceria novo", async () => {
    // Tratar como "sem anterior" faria o motor de diff calar mudanças reais.
    const fake = fakeDb({ previousError: true });
    const { client } = fakeClient({ scanPages: [{ results: ["MLB1"], scroll_id: null }] });

    await expect(fetchListings(params(fake.db, client))).rejects.toThrow(/listings anteriores/);
  });

  it("projeta só os campos que `listings` usa", async () => {
    const fake = fakeDb({});
    const { client, requests } = fakeClient({ scanPages: [{ results: ["MLB1"], scroll_id: null }] });

    await fetchListings(params(fake.db, client));

    const multiget = requests.find((request) => request.path === "/items");

    expect(String(multiget?.searchParams?.attributes)).toContain("available_quantity");
    expect(String(multiget?.searchParams?.attributes)).not.toContain("descriptions");
  });
});
