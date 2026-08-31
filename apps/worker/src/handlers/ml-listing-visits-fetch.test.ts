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
  item_id: string;
}

/**
 * Fake range-aware: as duas leituras reais passam por `readAllPages`
 * (`.order().range()`, D-131/D-156), então o fake fatia pelos argumentos do
 * `range` — o que também torna a paginação TESTÁVEL de verdade, não simulada.
 */
function fakeDb(options: {
  links?: Link[];
  /** Itens com linha recente em `daily_listing_visits` — o checkpoint de D-156. */
  recentItemIds?: string[];
  upsertFailsFor?: string[];
  listingsError?: boolean;
}): {
  db: FetchListingVisitsParams["db"];
  upserted: Record<string, unknown>[];
  listingsRanges: [number, number][];
} {
  const links = options.links ?? [];
  const recentRows = (options.recentItemIds ?? []).map((item_id) => ({ item_id }));
  const upserted: Record<string, unknown>[] = [];
  const listingsRanges: [number, number][] = [];

  function tableChain(rows: Link[], error: { message: string } | null, ranges?: [number, number][]): unknown {
    const self = {
      eq: () => self,
      is: () => self,
      gte: () => self,
      order: () => self,
      range: (from: number, to: number) => {
        ranges?.push([from, to]);

        if (error !== null) {
          return Promise.resolve({ data: null, error });
        }

        return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
      },
    };

    return self;
  }

  const db = {
    from: (table: string) => ({
      select: () => {
        if (table === "listings") {
          return tableChain(links, options.listingsError === true ? { message: "boom" } : null, listingsRanges);
        }

        if (table === "daily_listing_visits") {
          return tableChain(recentRows, null);
        }

        return tableChain([], null);
      },
      upsert: (row: Record<string, unknown>) => {
        upserted.push(row);

        const fails = options.upsertFailsFor?.includes(row.metric_date as string) ?? false;

        return Promise.resolve(fails ? { data: null, error: { message: "boom" } } : { data: null, error: null });
      },
    }),
  } as unknown as FetchListingVisitsParams["db"];

  return { db, upserted, listingsRanges };
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
    // Instantâneo nos testes; o teste de espaçamento injeta o seu próprio.
    sleep: () => Promise.resolve(),
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
  it("nenhum anúncio ativo: zero processados, zero requests", async () => {
    const { db } = fakeDb({ links: [] });
    const { client, requests } = fakeMercadoLivreClient({});

    const result = await fetchListingVisits(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 0, itemsFailed: 0, itemsSkipped: 0 });
    expect(requests).toHaveLength(0);
  });

  it("grava uma linha por dia de results[], data em YYYY-MM-DD (sem passar por Date)", async () => {
    const { db, upserted } = fakeDb({ links: [{ item_id: "MLB1" }] });
    const { client, requests } = fakeMercadoLivreClient({ MLB1: TIME_WINDOW_MLB1 });

    const result = await fetchListingVisits(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 1, itemsFailed: 0, itemsSkipped: 0 });
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

  it("percorre múltiplos anúncios, um item por vez — a API aceita 1 id por chamada", async () => {
    const { db, upserted } = fakeDb({ links: [{ item_id: "MLB1" }, { item_id: "MLB2" }] });
    const { client } = fakeMercadoLivreClient({
      MLB1: TIME_WINDOW_MLB1,
      MLB2: { item_id: "MLB2", results: [{ date: "2026-08-22T00:00:00Z", total: 5 }] },
    });

    const result = await fetchListingVisits(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 2, itemsFailed: 0, itemsSkipped: 0 });
    expect(upserted).toHaveLength(3);
    expect(upserted.filter((row) => row.item_id === "MLB2")).toHaveLength(1);
  });

  it("anúncio COM variação entra — era a lacuna da enumeração por vínculo", async () => {
    // A enumeração antiga deixava de fora exatamente estes: 1.539 ativos,
    // medido em 2026-08-28 (D-124).
    const { db, upserted } = fakeDb({ links: [{ item_id: "MLB-com-variacao" }] });
    const { client } = fakeMercadoLivreClient({ "MLB-com-variacao": TIME_WINDOW_MLB1 });

    const result = await fetchListingVisits(baseParams(db, client));

    expect(result.itemsProcessed).toBe(1);
    expect(upserted[0]?.item_id).toBe("MLB-com-variacao");
  });

  it("checkpoint (D-156): item sincronizado na janela é PULADO — a tentativa seguinte soma progresso em vez de repetir", async () => {
    const { db, upserted } = fakeDb({
      links: [{ item_id: "MLB1" }, { item_id: "MLB2" }],
      recentItemIds: ["MLB1"],
    });
    const { client, requests } = fakeMercadoLivreClient({
      MLB2: { item_id: "MLB2", results: [{ date: "2026-08-22T00:00:00Z", total: 5 }] },
    });

    const result = await fetchListingVisits(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 1, itemsFailed: 0, itemsSkipped: 1 });
    // A prova do que importa: NENHUMA chamada ao Mercado Livre para o item já feito.
    expect(requests.map((r) => r.path)).toEqual(["/items/MLB2/visits/time_window"]);
    expect(upserted.every((row) => row.item_id === "MLB2")).toBe(true);
  });

  it("espaçamento (D-156): dorme ENTRE chamadas, nunca antes da primeira — e item pulado não paga espera", async () => {
    const sleeps: number[] = [];
    const { db } = fakeDb({
      links: [{ item_id: "MLB0" }, { item_id: "MLB1" }, { item_id: "MLB2" }],
      recentItemIds: ["MLB0"],
    });
    const { client } = fakeMercadoLivreClient({
      MLB1: TIME_WINDOW_MLB1,
      MLB2: { item_id: "MLB2", results: [{ date: "2026-08-22T00:00:00Z", total: 5 }] },
    });

    const params = baseParams(db, client);
    params.sleep = (ms) => {
      sleeps.push(ms);

      return Promise.resolve();
    };

    await fetchListingVisits(params);

    // 2 chamadas reais ⇒ 1 espera, entre elas.
    expect(sleeps).toEqual([150]);
  });

  it("enumeração paginada (D-131/D-156): mais de 1.000 ativos atravessa o teto do PostgREST em páginas", async () => {
    const links = Array.from({ length: 1002 }, (_, index) => ({
      item_id: `MLB${String(index).padStart(4, "0")}`,
    }));
    const { db, listingsRanges } = fakeDb({ links, recentItemIds: links.slice(2).map((l) => l.item_id) });
    const { client, requests } = fakeMercadoLivreClient({
      MLB0000: TIME_WINDOW_MLB1,
      MLB0001: TIME_WINDOW_MLB1,
    });

    const result = await fetchListingVisits(baseParams(db, client));

    // Duas páginas de listings — sem o `.range()`, os 2 últimos itens não existiriam.
    expect(listingsRanges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(result.itemsSkipped).toBe(1000);
    expect(requests).toHaveLength(2);
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

    expect(result).toEqual({ itemsProcessed: 1, itemsFailed: 1, itemsSkipped: 0 });
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

  it("429 esgotado no MEIO da lista: o que veio antes já está persistido — é o que o checkpoint aproveita na tentativa seguinte", async () => {
    const { db, upserted } = fakeDb({ links: [{ item_id: "MLB1" }, { item_id: "MLB-limitado" }] });
    const client = {
      request: (options: RequestOptions<unknown>) => {
        if (options.path === "/items/MLB-limitado/visits/time_window") {
          return Promise.reject(
            new MercadoLivreApiError("rate limited", { status: 429, errorClass: "retryable", url: "x" }),
          );
        }

        return Promise.resolve(TIME_WINDOW_MLB1);
      },
    } as unknown as MercadoLivreClient;

    await expect(fetchListingVisits(baseParams(db, client))).rejects.toThrow(MercadoLivreApiError);
    expect(upserted.filter((row) => row.item_id === "MLB1")).toHaveLength(2);
  });

  it("falha ao gravar um dos dias (erro de banco): item não conta como processado", async () => {
    const { db, upserted } = fakeDb({
      links: [{ item_id: "MLB1" }],
      upsertFailsFor: ["2026-08-22"],
    });
    const { client } = fakeMercadoLivreClient({ MLB1: TIME_WINDOW_MLB1 });

    const result = await fetchListingVisits(baseParams(db, client));

    expect(result).toEqual({ itemsProcessed: 0, itemsFailed: 0, itemsSkipped: 0 });
    expect(upserted).toHaveLength(2);
  });

  it("falha ao ler listings rejeita — sem isto viraria 'done, 0 processados', igual a uma conta sem anúncio", async () => {
    const { db } = fakeDb({ listingsError: true });
    const { client } = fakeMercadoLivreClient({});

    await expect(fetchListingVisits(baseParams(db, client))).rejects.toThrow(/listings/);
  });
});
