import { describe, expect, it, vi } from "vitest";

import type { MercadoLivreClient } from "./http-client.js";
import {
  ITEMS_MULTIGET_MAX_IDS,
  chunkItemIds,
  getItemsBatch,
  itemsMultigetSchema,
  scanSellerItems,
  sellerItemsScanPageSchema,
} from "./items.js";

interface Call {
  path: string;
  searchParams: Record<string, unknown> | undefined;
}

function fakeClient(pages: unknown[]): { client: MercadoLivreClient; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;

  const request = async (options: {
    path: string;
    searchParams?: Record<string, unknown>;
    schema: { parse: (value: unknown) => unknown };
  }): Promise<unknown> => {
    calls.push({ path: options.path, searchParams: options.searchParams });

    const page = pages[index] ?? { results: [] };
    index += 1;

    return await Promise.resolve(options.schema.parse(page));
  };

  const client = { request: vi.fn(request) } as unknown as MercadoLivreClient;

  return { client, calls };
}

async function drain(generator: AsyncGenerator<string[], void, void>): Promise<string[]> {
  const all: string[] = [];

  for await (const batch of generator) {
    all.push(...batch);
  }

  return all;
}

describe("sellerItemsScanPageSchema", () => {
  it("aceita as TRÊS formas do fim da lista — a doc não diz qual campo vira null", () => {
    expect(sellerItemsScanPageSchema.parse({ results: [], scroll_id: null }).results).toEqual([]);
    expect(sellerItemsScanPageSchema.parse({ results: [] }).results).toEqual([]);
    expect(sellerItemsScanPageSchema.parse({ results: ["MLB1"], scroll_id: "abc" }).scroll_id).toBe("abc");
  });

  it("ignora os campos que não usamos (paging, orders, available_orders)", () => {
    const page = sellerItemsScanPageSchema.parse({
      results: ["MLB1"],
      scroll_id: "abc",
      paging: { limit: 100, offset: 0, total: 2675 },
      available_orders: [{ id: "stop_time_asc", name: "x" }],
    });

    expect(page.results).toEqual(["MLB1"]);
  });
});

describe("scanSellerItems", () => {
  it("percorre o catálogo inteiro reusando o MESMO scroll_id", async () => {
    const { client, calls } = fakeClient([
      { results: ["MLB1", "MLB2"], scroll_id: "s1" },
      { results: ["MLB3"], scroll_id: "s1" },
      { results: [], scroll_id: null },
    ]);

    const ids = await drain(scanSellerItems({ client, sellerId: 123, accessToken: "t", limit: 100 }));

    expect(ids).toEqual(["MLB1", "MLB2", "MLB3"]);
    expect(calls[0]?.path).toBe("/users/123/items/search");
  });

  it("`limit` SÓ na primeira chamada; as seguintes levam scroll_id e nenhum dos dois", async () => {
    // Duas páginas oficiais se contradizem sobre `limit` + `scroll_id`; a mais
    // recente diz que causa erro. Este teste trava o recorte conservador.
    const { client, calls } = fakeClient([
      { results: ["MLB1"], scroll_id: "s1" },
      { results: [], scroll_id: null },
    ]);

    await drain(scanSellerItems({ client, sellerId: 123, accessToken: "t", limit: 100 }));

    expect(calls[0]?.searchParams).toEqual({ search_type: "scan", limit: 100 });
    expect(calls[1]?.searchParams).toEqual({ search_type: "scan", scroll_id: "s1" });
    expect(calls[1]?.searchParams).not.toHaveProperty("limit");
    expect(calls[1]?.searchParams).not.toHaveProperty("offset");
  });

  it("NUNCA envia ordenação — `orders` aqui, `sort` no outro endpoint (armadilha do D-109)", async () => {
    const { client, calls } = fakeClient([{ results: ["MLB1"], scroll_id: null }]);

    await drain(scanSellerItems({ client, sellerId: 123, accessToken: "t" }));

    expect(calls[0]?.searchParams).not.toHaveProperty("orders");
    expect(calls[0]?.searchParams).not.toHaveProperty("sort");
  });

  it("resposta sem scroll_id encerra em vez de repetir a primeira página para sempre", async () => {
    const { client, calls } = fakeClient([
      { results: ["MLB1"] },
      { results: ["MLB1"] },
    ]);

    const ids = await drain(scanSellerItems({ client, sellerId: 1, accessToken: "t" }));

    expect(ids).toEqual(["MLB1"]);
    expect(calls).toHaveLength(1);
  });

  it("catálogo vazio não gera lote nenhum", async () => {
    const { client } = fakeClient([{ results: [], scroll_id: null }]);

    expect(await drain(scanSellerItems({ client, sellerId: 1, accessToken: "t" }))).toEqual([]);
  });

  it("maxPages é teto de segurança contra scroll que nunca termina", async () => {
    const infinitas = Array.from({ length: 50 }, () => ({ results: ["MLB1"], scroll_id: "s1" }));
    const { client, calls } = fakeClient(infinitas);

    await drain(scanSellerItems({ client, sellerId: 1, accessToken: "t", maxPages: 3 }));

    expect(calls).toHaveLength(3);
  });
});

describe("chunkItemIds", () => {
  it("fatia em lotes de 20 — o máximo documentado", () => {
    const ids = Array.from({ length: 45 }, (_, i) => `MLB${String(i)}`);
    const chunks = chunkItemIds(ids);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(ITEMS_MULTIGET_MAX_IDS);
    expect(chunks[2]).toHaveLength(5);
    expect(chunks.flat()).toEqual(ids);
  });

  it("lista vazia não vira lote vazio", () => {
    expect(chunkItemIds([])).toEqual([]);
  });
});

describe("getItemsBatch", () => {
  it("monta ids separados por vírgula e projeta atributos", async () => {
    const { client, calls } = fakeClient([[{ code: 200, body: { id: "MLB1" } }]]);

    const entries = await getItemsBatch({
      client,
      ids: ["MLB1", "MLB2"],
      accessToken: "t",
      attributes: ["id", "title"],
    });

    expect(calls[0]?.path).toBe("/items");
    expect(calls[0]?.searchParams).toEqual({ ids: "MLB1,MLB2", attributes: "id,title" });
    expect(entries[0]?.code).toBe(200);
  });

  it("acima de 20 ids FALHA em vez de deixar a API truncar em silêncio", async () => {
    // A doc não diz o que acontece acima de 20. Descobrir depois que metade
    // do catálogo sumiu é pior que falhar aqui.
    const { client } = fakeClient([[]]);
    const ids = Array.from({ length: 21 }, (_, i) => `MLB${String(i)}`);

    await expect(getItemsBatch({ client, ids, accessToken: "t" })).rejects.toThrow(/no máximo 20/);
  });

  it("lista vazia não chama a API", async () => {
    const { client, calls } = fakeClient([[]]);

    expect(await getItemsBatch({ client, ids: [], accessToken: "t" })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("o envelope verbose preserva falha POR ITEM, não da chamada", () => {
    const entries = itemsMultigetSchema.parse([
      { code: 200, body: { id: "MLB1" } },
      { code: 404, body: { message: "Item not found" } },
    ]);

    expect(entries.filter((entry) => entry.code === 200)).toHaveLength(1);
    expect(entries[1]?.code).toBe(404);
  });
});
