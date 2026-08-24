import { createLogger } from "@sb/observability";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { describe, expect, it } from "vitest";

import type { FetchListingsParams } from "./ml-listings-fetch.js";
import { fetchListings } from "./ml-listings-fetch.js";

const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SYNCED_AT = new Date("2026-08-23T18:00:00.000Z");

interface Link {
  item_id: string | null;
  sku_id: string;
}

/** Fake mínimo, encadeável — mesmo espírito de ml-fulfillment-fetch.test.ts. */
function chain<T>(result: T): { eq: () => ReturnType<typeof chain<T>>; is: () => ReturnType<typeof chain<T>> } & Promise<T> {
  const self = {
    eq: () => self,
    is: () => self,
    then: (resolve: (value: T) => unknown) => Promise.resolve(result).then(resolve),
  };

  return self as unknown as { eq: () => ReturnType<typeof chain<T>>; is: () => ReturnType<typeof chain<T>> } &
    Promise<T>;
}

function fakeDb(options: {
  links?: Link[];
  upsertFails?: boolean;
  linksError?: boolean;
}): { db: FetchListingsParams["db"]; upserted: Record<string, unknown>[] } {
  const links = options.links ?? [];
  const upserted: Record<string, unknown>[] = [];

  const db = {
    from: (table: string) => ({
      select: () => {
        if (table === "sku_listing_links") {
          return chain(
            options.linksError === true ? { data: null, error: { message: "boom" } } : { data: links, error: null },
          );
        }

        return chain({ data: null, error: null });
      },
      upsert: (row: Record<string, unknown>) => {
        upserted.push(row);

        return Promise.resolve(
          options.upsertFails === true ? { data: null, error: { message: "boom" } } : { data: null, error: null },
        );
      },
    }),
  } as unknown as FetchListingsParams["db"];

  return { db, upserted };
}

function fakeMercadoLivreClient(
  itemsById: Record<string, Record<string, unknown>>,
): { client: MercadoLivreClient; requests: RequestOptions<unknown>[] } {
  const requests: RequestOptions<unknown>[] = [];

  const client = {
    request: (options: RequestOptions<unknown>) => {
      requests.push(options);

      const match = /^\/items\/(.+)$/.exec(options.path);
      const item = match?.[1] !== undefined ? itemsById[match[1]] : undefined;

      if (item === undefined) {
        throw new Error(`item inesperado no fake: ${options.path}`);
      }

      return Promise.resolve(item);
    },
  } as unknown as MercadoLivreClient;

  return { client, requests };
}

function baseParams(
  db: FetchListingsParams["db"],
  client: MercadoLivreClient,
  lines: string[] = [],
): FetchListingsParams {
  return {
    db,
    organizationId: ORGANIZATION_ID,
    mlAccountId: ML_ACCOUNT_ID,
    mercadoLivre: client,
    accessToken: "APP_USR-token",
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    now: () => SYNCED_AT,
  };
}

const ITEM_MLB1 = {
  id: "MLB1",
  title: "Cabo de freio dianteiro",
  status: "active",
  price: 29.9,
  currency_id: "BRL",
  available_quantity: 12,
  category_id: "MLB1234",
};

describe("fetchListings (D-058)", () => {
  it("nenhum vínculo sem variação: zero processados, zero requests", async () => {
    const { db } = fakeDb({ links: [] });
    const { client, requests } = fakeMercadoLivreClient({});

    const result = await fetchListings(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 0, itemsFailed: 0 });
    expect(requests).toHaveLength(0);
  });

  it("grava o listing com os campos certos, upsert por (ml_account_id, item_id)", async () => {
    const { db, upserted } = fakeDb({ links: [{ item_id: "MLB1", sku_id: "sku-1" }] });
    const { client, requests } = fakeMercadoLivreClient({ MLB1: ITEM_MLB1 });

    const result = await fetchListings(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 1, itemsFailed: 0 });
    expect(upserted[0]).toMatchObject({
      organization_id: ORGANIZATION_ID,
      ml_account_id: ML_ACCOUNT_ID,
      item_id: "MLB1",
      sku_id: "sku-1",
      title: "Cabo de freio dianteiro",
      status: "active",
      price: 29.9,
      currency_id: "BRL",
      available_quantity: 12,
      category_id: "MLB1234",
      synced_at: SYNCED_AT.toISOString(),
    });
    expect(requests.map((r) => r.path)).toEqual(["/items/MLB1"]);
  });

  it("category_id ausente vira null, não quebra", async () => {
    const { db, upserted } = fakeDb({ links: [{ item_id: "MLB1", sku_id: "sku-1" }] });
    const { client } = fakeMercadoLivreClient({ MLB1: { ...ITEM_MLB1, category_id: undefined } });

    await fetchListings(baseParams(db, client));

    expect(upserted[0]?.category_id).toBeNull();
  });

  it("percorre múltiplos vínculos, um item por vez", async () => {
    const { db, upserted } = fakeDb({
      links: [
        { item_id: "MLB1", sku_id: "sku-1" },
        { item_id: "MLB2", sku_id: "sku-2" },
      ],
    });
    const { client } = fakeMercadoLivreClient({
      MLB1: ITEM_MLB1,
      MLB2: { ...ITEM_MLB1, id: "MLB2" },
    });

    const result = await fetchListings(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 2, itemsFailed: 0 });
    expect(upserted.map((row) => row.item_id)).toEqual(["MLB1", "MLB2"]);
  });

  it("item sem item_id (defesa) é ignorado sem crashar", async () => {
    const { db } = fakeDb({ links: [{ item_id: null, sku_id: "sku-1" }] });
    const { client, requests } = fakeMercadoLivreClient({});

    const result = await fetchListings(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 0, itemsFailed: 0 });
    expect(requests).toHaveLength(0);
  });

  it("404 ao buscar /items/{id} (anúncio removido): pula só esse item, mesmo raciocínio de Full", async () => {
    const { db, upserted } = fakeDb({
      links: [
        { item_id: "MLB-removido", sku_id: "sku-1" },
        { item_id: "MLB2", sku_id: "sku-2" },
      ],
    });
    const client = {
      request: (options: RequestOptions<unknown>) => {
        if (options.path === "/items/MLB-removido") {
          return Promise.reject(
            new MercadoLivreApiError("não encontrado", { status: 404, errorClass: "not_retryable", url: "x" }),
          );
        }

        return Promise.resolve({ ...ITEM_MLB1, id: "MLB2" });
      },
    } as unknown as MercadoLivreClient;

    const result = await fetchListings(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 1, itemsFailed: 1 });
    expect(upserted).toHaveLength(1);
    expect(upserted[0]?.item_id).toBe("MLB2");
  });

  it("erro RETRYABLE (ex.: 503) num item propaga — não é engolido como itemsFailed", async () => {
    const { db } = fakeDb({ links: [{ item_id: "MLB1", sku_id: "sku-1" }] });
    const client = {
      request: () =>
        Promise.reject(new MercadoLivreApiError("indisponível", { status: 503, errorClass: "retryable", url: "x" })),
    } as unknown as MercadoLivreClient;

    await expect(fetchListings(baseParams(db, client))).rejects.toThrow(MercadoLivreApiError);
  });

  it("falha ao gravar (erro de banco, não conflito): não conta como processado, segue para o próximo", async () => {
    const { db, upserted } = fakeDb({
      links: [
        { item_id: "MLB1", sku_id: "sku-1" },
        { item_id: "MLB2", sku_id: "sku-2" },
      ],
      upsertFails: true,
    });
    const { client } = fakeMercadoLivreClient({ MLB1: ITEM_MLB1, MLB2: { ...ITEM_MLB1, id: "MLB2" } });

    const result = await fetchListings(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 0, itemsFailed: 0 });
    expect(upserted).toHaveLength(2);
  });

  it("falha ao ler sku_listing_links rejeita — sem isto viraria 'done, 0 processados', igual a uma conta sem anúncio", async () => {
    const { db } = fakeDb({ linksError: true });
    const { client } = fakeMercadoLivreClient({});

    await expect(fetchListings(baseParams(db, client))).rejects.toThrow(/sku_listing_links/);
  });
});
