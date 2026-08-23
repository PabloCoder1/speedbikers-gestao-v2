import { createLogger } from "@sb/observability";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { describe, expect, it } from "vitest";

import type { FetchListingVisitsParams } from "./ml-listing-visits-fetch.js";
import { fetchListingVisits } from "./ml-listing-visits-fetch.js";

const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SYNCED_AT = new Date("2026-08-23T18:00:00.000Z");

interface Link {
  item_id: string | null;
}

/** Fake mínimo, encadeável — mesmo espírito de ml-listings-fetch.test.ts. */
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
  upsertFailsFor?: string[];
}): { db: FetchListingVisitsParams["db"]; upserted: Record<string, unknown>[] } {
  const links = options.links ?? [];
  const upserted: Record<string, unknown>[] = [];

  const db = {
    from: (table: string) => ({
      select: () => {
        if (table === "sku_listing_links") {
          return chain({ data: links, error: null });
        }

        return chain({ data: null, error: null });
      },
      upsert: (row: Record<string, unknown>) => {
        upserted.push(row);

        const fails = options.upsertFailsFor?.includes(row.metric_date as string) ?? false;

        return Promise.resolve(fails ? { data: null, error: { message: "boom" } } : { data: null, error: null });
      },
    }),
  } as unknown as FetchListingVisitsParams["db"];

  return { db, upserted };
}

function fakeMercadoLivreClient(
  timeWindowsByItem: Record<string, Record<string, unknown>>,
): { client: MercadoLivreClient; requests: RequestOptions<unknown>[] } {
  const requests: RequestOptions<unknown>[] = [];

  const client = {
    request: (options: RequestOptions<unknown>) => {
      requests.push(options);

      const match = /^\/items\/(.+)\/visits\/time_window$/.exec(options.path);
      const timeWindow = match?.[1] !== undefined ? timeWindowsByItem[match[1]] : undefined;

      if (timeWindow === undefined) {
        throw new Error(`item inesperado no fake: ${options.path}`);
      }

      return Promise.resolve(timeWindow);
    },
  } as unknown as MercadoLivreClient;

  return { client, requests };
}

function baseParams(
  db: FetchListingVisitsParams["db"],
  client: MercadoLivreClient,
  lines: string[] = [],
): FetchListingVisitsParams {
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

const TIME_WINDOW_MLB1 = {
  item_id: "MLB1",
  results: [
    { date: "2026-08-21T00:00:00Z", total: 10 },
    { date: "2026-08-22T00:00:00Z", total: 16 },
  ],
};

describe("fetchListingVisits (D-032)", () => {
  it("nenhum vínculo sem variação: zero processados, zero requests", async () => {
    const { db } = fakeDb({ links: [] });
    const { client, requests } = fakeMercadoLivreClient({});

    const result = await fetchListingVisits(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 0, itemsFailed: 0 });
    expect(requests).toHaveLength(0);
  });

  it("grava uma linha por dia de results[], data em YYYY-MM-DD (sem passar por Date)", async () => {
    const { db, upserted } = fakeDb({ links: [{ item_id: "MLB1" }] });
    const { client, requests } = fakeMercadoLivreClient({ MLB1: TIME_WINDOW_MLB1 });

    const result = await fetchListingVisits(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 1, itemsFailed: 0 });
    expect(upserted).toEqual([
      {
        organization_id: ORGANIZATION_ID,
        ml_account_id: ML_ACCOUNT_ID,
        item_id: "MLB1",
        metric_date: "2026-08-21",
        visits: 10,
        synced_at: SYNCED_AT.toISOString(),
      },
      {
        organization_id: ORGANIZATION_ID,
        ml_account_id: ML_ACCOUNT_ID,
        item_id: "MLB1",
        metric_date: "2026-08-22",
        visits: 16,
        synced_at: SYNCED_AT.toISOString(),
      },
    ]);
    expect(requests.map((r) => r.path)).toEqual(["/items/MLB1/visits/time_window"]);
    expect(requests[0]?.searchParams).toEqual({ last: 3, unit: "day" });
  });

  it("percorre múltiplos vínculos, um item por vez", async () => {
    const { db, upserted } = fakeDb({ links: [{ item_id: "MLB1" }, { item_id: "MLB2" }] });
    const { client } = fakeMercadoLivreClient({
      MLB1: TIME_WINDOW_MLB1,
      MLB2: { item_id: "MLB2", results: [{ date: "2026-08-22T00:00:00Z", total: 5 }] },
    });

    const result = await fetchListingVisits(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 2, itemsFailed: 0 });
    expect(upserted).toHaveLength(3);
    expect(upserted.filter((row) => row.item_id === "MLB2")).toHaveLength(1);
  });

  it("item sem item_id (defesa) é ignorado sem crashar", async () => {
    const { db } = fakeDb({ links: [{ item_id: null }] });
    const { client, requests } = fakeMercadoLivreClient({});

    const result = await fetchListingVisits(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 0, itemsFailed: 0 });
    expect(requests).toHaveLength(0);
  });

  it("404 ao buscar time_window (anúncio removido): pula só esse item, mesmo raciocínio de listings/Full", async () => {
    const { db, upserted } = fakeDb({ links: [{ item_id: "MLB-removido" }, { item_id: "MLB2" }] });
    const client = {
      request: (options: RequestOptions<unknown>) => {
        if (options.path === "/items/MLB-removido/visits/time_window") {
          return Promise.reject(
            new MercadoLivreApiError("não encontrado", { status: 404, errorClass: "not_retryable", url: "x" }),
          );
        }

        return Promise.resolve({ item_id: "MLB2", results: [{ date: "2026-08-22T00:00:00Z", total: 5 }] });
      },
    } as unknown as MercadoLivreClient;

    const result = await fetchListingVisits(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 1, itemsFailed: 1 });
    expect(upserted).toHaveLength(1);
    expect(upserted[0]?.item_id).toBe("MLB2");
  });

  it("erro RETRYABLE (ex.: 503) num item propaga — não é engolido como itemsFailed", async () => {
    const { db } = fakeDb({ links: [{ item_id: "MLB1" }] });
    const client = {
      request: () =>
        Promise.reject(new MercadoLivreApiError("indisponível", { status: 503, errorClass: "retryable", url: "x" })),
    } as unknown as MercadoLivreClient;

    await expect(fetchListingVisits(baseParams(db, client))).rejects.toThrow(MercadoLivreApiError);
  });

  it("falha ao gravar um dos dias (erro de banco): item não conta como processado", async () => {
    const { db, upserted } = fakeDb({
      links: [{ item_id: "MLB1" }],
      upsertFailsFor: ["2026-08-22"],
    });
    const { client } = fakeMercadoLivreClient({ MLB1: TIME_WINDOW_MLB1 });

    const result = await fetchListingVisits(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 0, itemsFailed: 0 });
    expect(upserted).toHaveLength(2);
  });
});
