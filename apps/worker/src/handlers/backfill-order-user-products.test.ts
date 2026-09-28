import { randomBytes } from "node:crypto";

import { MercadoLivreApiError, encryptToken } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { EnqueueRequest } from "../enqueue.js";
import type { BackfillOrderUserProductsDeps } from "./backfill-order-user-products.js";
import { createBackfillOrderUserProductsHandler } from "./backfill-order-user-products.js";

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ENCRYPTION_KEY = randomBytes(32);
const NOW = new Date("2026-09-23T15:00:00.000Z");

const ATE = "2026-09-16T15:00:00.000Z";
const LIMITE = "2026-06-25T15:00:00.000Z";

const ENVELOPE = {
  jobType: "backfill.order-user-products",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b57",
  organizationId: ORGANIZATION_ID,
  dedupeKey: "backfill-order-user-products:loja-1:inicio",
  attempt: 1,
  enqueuedAt: NOW.toISOString(),
};

interface OrderRow {
  id: number;
  date_created: string;
}

interface ItemRow {
  id: string;
  order_id: number;
  position: number;
  item_id: string;
  variation_id: string | null;
  user_product_id: string | null;
  sku_id: string | null;
  sku_listing_link_id?: string | null;
}

interface LinkRow {
  id: string;
  sku_id: string;
  ref_kind: "ITEM" | "USER_PRODUCT";
  item_id: string | null;
  variation_id: string | null;
  user_product_id: string | null;
}

function fakeDb(options: { orders?: OrderRow[]; items?: ItemRow[]; links?: LinkRow[]; accountStatus?: string }): {
  db: BackfillOrderUserProductsDeps["db"];
  items: ItemRow[];
  updates: Record<string, unknown>[];
  syncRuns: Record<string, unknown>[];
  tabelas: Set<string>;
  filtrosDePedidos: Record<string, unknown>;
} {
  const orders = options.orders ?? [];
  const items = (options.items ?? []).map((item) => ({ ...item }));
  const links = options.links ?? [];
  const updates: Record<string, unknown>[] = [];
  const syncRuns: Record<string, unknown>[] = [];
  const tabelas = new Set<string>();
  const filtrosDePedidos: Record<string, unknown> = {};

  const credentials = {
    access_token_ciphertext: encryptToken("APP_USR-valido", ENCRYPTION_KEY),
    refresh_token_ciphertext: encryptToken("TG-valido", ENCRYPTION_KEY),
    access_token_expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
  };

  function pedidos(): unknown {
    const self = {
      eq: () => self,
      in: () => self,
      gte: (_coluna: string, valor: string) => {
        filtrosDePedidos.gte = valor;

        return self;
      },
      lt: (_coluna: string, valor: string) => {
        filtrosDePedidos.lt = valor;

        return self;
      },
      order: () => self,
      range: (from: number, to: number) => Promise.resolve({ data: orders.slice(from, to + 1), error: null }),
    };

    return self;
  }

  /** `sku_listing_links`: casa todos os `eq`/`is` e devolve a forma do embed (D-188). */
  function vinculos(): unknown {
    const filtros: Record<string, unknown> = {};
    const self = {
      eq: (coluna: string, valor: unknown) => {
        filtros[coluna] = valor;

        return self;
      },
      is: (coluna: string, valor: unknown) => {
        filtros[coluna] = valor;

        return self;
      },
      maybeSingle: () => {
        const link = links.find(
          (l) =>
            l.ref_kind === filtros.ref_kind &&
            (filtros.item_id === undefined || l.item_id === filtros.item_id) &&
            (!("variation_id" in filtros) || l.variation_id === filtros.variation_id) &&
            (filtros.user_product_id === undefined || l.user_product_id === filtros.user_product_id),
        );

        return Promise.resolve({
          data: link === undefined ? null : { ...link, skus: { kind: "PRODUTO", sku_components: [] } },
          error: null,
        });
      },
    };

    return self;
  }

  function singleChain(result: unknown): unknown {
    const self = {
      eq: () => self,
      maybeSingle: () => Promise.resolve({ data: result, error: null }),
      select: () => self,
      single: () => Promise.resolve({ data: { id: "run-1" }, error: null }),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: { id: "run-1" }, error: null }).then(resolve),
    };

    return self;
  }

  const db = {
    from: (table: string) => {
      tabelas.add(table);

      return {
        select: () => {
          if (table === "ml_accounts") {
            return singleChain({
              id: ML_ACCOUNT_ID,
              organization_id: ORGANIZATION_ID,
              slug: "loja-1",
              status: options.accountStatus ?? "CONNECTED",
            });
          }

          if (table === "ml_credentials") return singleChain(credentials);
          if (table === "orders") return pedidos();
          if (table === "sku_listing_links") return vinculos();

          if (table === "order_items") {
            return {
              in: (_coluna: string, ids: number[]) => ({
                is: () =>
                  Promise.resolve({
                    data: items
                      .filter((item) => ids.includes(item.order_id) && item.sku_id === null)
                      .map(({ id, order_id, position, item_id, variation_id, user_product_id }) => ({
                        id,
                        order_id,
                        position,
                        item_id,
                        variation_id,
                        user_product_id,
                      })),
                    error: null,
                  }),
              }),
            };
          }

          return singleChain(null);
        },
        update: (campos: Record<string, unknown>) => ({
          eq: (_coluna: string, id: string) => ({
            is: () => {
              const item = items.find((i) => i.id === id);

              if (item?.sku_id === null) {
                Object.assign(item, campos);
                updates.push({ id, ...campos });
              }

              return Promise.resolve({ error: null });
            },
          }),
        }),
        insert: (row: Record<string, unknown>) => {
          if (table === "sync_runs") syncRuns.push(row);

          return singleChain({ id: "run-1" });
        },
      };
    },
  } as unknown as BackfillOrderUserProductsDeps["db"];

  return { db, items, updates, syncRuns, tabelas, filtrosDePedidos };
}

/** O `GET /orders/{id}` com um item por pedido, e o user product que ele traz. */
function pedidoDoMl(id: number, itemId: string, userProductId: string | null): unknown {
  return {
    id,
    status: "paid",
    date_created: "2026-09-15T20:00:00.000-03:00",
    total_amount: 100,
    currency_id: "BRL",
    order_items: [
      {
        item: { id: itemId, title: "Produto", variation_id: null, user_product_id: userProductId },
        quantity: 1,
        unit_price: 100,
        currency_id: "BRL",
      },
    ],
  };
}

function fakeClient(respostas: Record<number, unknown>): { client: MercadoLivreClient; calls: string[] } {
  const calls: string[] = [];

  const client = {
    request: (request: RequestOptions<unknown>) => {
      calls.push(request.path);

      const id = Number(request.path.split("/").pop());
      const resposta = respostas[id];

      if (resposta instanceof Error) return Promise.reject(resposta);

      return Promise.resolve(request.schema.parse(resposta));
    },
  } as unknown as MercadoLivreClient;

  return { client, calls };
}

function run(
  db: BackfillOrderUserProductsDeps["db"],
  client: MercadoLivreClient,
  payload: Record<string, unknown> = { mlAccountId: ML_ACCOUNT_ID, ate: ATE, limite: LIMITE },
) {
  const enfileirados: EnqueueRequest[] = [];
  const handler = createBackfillOrderUserProductsHandler({
    db,
    mercadoLivre: client,
    oauth: { clientId: "APP_ID", clientSecret: "segredo", redirectUri: "" },
    encryptionKey: ENCRYPTION_KEY,
    now: () => NOW,
    sleep: () => Promise.resolve(),
    enqueuer: {
      enqueue: (request) => {
        enfileirados.push(request);

        return Promise.resolve({ deduplicated: false });
      },
    } as BackfillOrderUserProductsDeps["enqueuer"],
  });

  const lines: string[] = [];

  return handler(ENVELOPE, { logger: createLogger({}, { sink: (line) => lines.push(line) }), payload }).then(
    (outcome) => ({ outcome, enfileirados, lines }),
  );
}

function item(orderId: number, itemId: string, userProductId: string | null = null, skuId: string | null = null): ItemRow {
  return {
    id: `oi-${String(orderId)}`,
    order_id: orderId,
    position: 0,
    item_id: itemId,
    variation_id: null,
    user_product_id: userProductId,
    sku_id: skuId,
  };
}

function link(id: string, skuId: string, chave: { item?: string; userProduct?: string }): LinkRow {
  return {
    id,
    sku_id: skuId,
    ref_kind: chave.item !== undefined ? "ITEM" : "USER_PRODUCT",
    item_id: chave.item ?? null,
    variation_id: null,
    user_product_id: chave.userProduct ?? null,
  };
}

describe("backfill.order-user-products (D-362, 3ª parte)", () => {
  it("resolve pela regra do worker, relê só o pedido sem user product e não toca no estoque", async () => {
    const { db, items, syncRuns, tabelas, filtrosDePedidos } = fakeDb({
      orders: [
        { id: 9001, date_created: "2026-09-15T16:00:00.000Z" },
        { id: 9002, date_created: "2026-09-16T01:00:00.000Z" },
        { id: 9003, date_created: "2026-09-16T14:00:00.000Z" },
        { id: 9004, date_created: "2026-09-16T14:30:00.000Z" },
        { id: 9005, date_created: "2026-09-16T14:40:00.000Z" },
      ],
      items: [
        // User product já gravado (veio de um webhook): resolve sem chamada.
        item(9001, "MLB1", "MLBU111"),
        // Sem user product: o pedido é relido e o user product lido tem vínculo.
        item(9002, "MLB2"),
        // Os dois vínculos: o por anúncio vence (decisão do dono de 16/09).
        item(9003, "MLB3", "MLBU333"),
        // Relido, o user product não tem vínculo: fica gravado, sem SKU.
        item(9004, "MLB4"),
        // Já com SKU: fora da busca.
        item(9005, "MLB5", null, "sku-ja"),
      ],
      links: [
        link("l-up1", "sku-1", { userProduct: "MLBU111" }),
        link("l-up2", "sku-2", { userProduct: "MLBU222" }),
        link("l-item3", "sku-3", { item: "MLB3" }),
        link("l-up3", "sku-errado", { userProduct: "MLBU333" }),
      ],
    });
    const { client, calls } = fakeClient({
      9002: pedidoDoMl(9002, "MLB2", "MLBU222"),
      9004: pedidoDoMl(9004, "MLB4", "MLBU444"),
    });

    const { outcome, enfileirados } = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 3 });
    expect(filtrosDePedidos).toEqual({ gte: "2026-09-15T15:00:00.000Z", lt: ATE });
    expect(calls).toEqual(["/orders/9002", "/orders/9004"]);
    expect(items.map((i) => [i.order_id, i.user_product_id, i.sku_id, i.sku_listing_link_id ?? null])).toEqual([
      [9001, "MLBU111", "sku-1", "l-up1"],
      [9002, "MLBU222", "sku-2", "l-up2"],
      [9003, "MLBU333", "sku-3", "l-item3"],
      [9004, "MLBU444", null, null],
      [9005, null, "sku-ja", null],
    ]);
    // Nenhum movimento: nem leitura nem escrita no ledger ou no saldo.
    expect([...tabelas].filter((t) => t.startsWith("stock") || t.startsWith("inventory"))).toEqual([]);
    expect(syncRuns[0]).toMatchObject({ resource: "orders", channel: "backfill", items_processed: 3 });
    // As métricas por SKU dos dias tocados (dia de São Paulo), e o pedaço anterior.
    expect(enfileirados).toEqual([
      {
        jobType: "analytics.recompute",
        organizationId: ORGANIZATION_ID,
        dedupeKey: `recompute:${ML_ACCOUNT_ID}:2026-09-15:2026-09-23T15:00Z`,
        queue: "analytics-recompute",
        payload: { mode: "incremental", mlAccountId: ML_ACCOUNT_ID, metricDate: "2026-09-15" },
        delaySeconds: 60,
      },
      {
        jobType: "analytics.recompute",
        organizationId: ORGANIZATION_ID,
        dedupeKey: `recompute:${ML_ACCOUNT_ID}:2026-09-16:2026-09-23T15:00Z`,
        queue: "analytics-recompute",
        payload: { mode: "incremental", mlAccountId: ML_ACCOUNT_ID, metricDate: "2026-09-16" },
        delaySeconds: 60,
      },
      {
        jobType: "backfill.order-user-products",
        organizationId: ORGANIZATION_ID,
        dedupeKey: "backfill-order-user-products:loja-1:2026-09-15T15:00:00.000Z",
        queue: "backfill",
        payload: { mlAccountId: ML_ACCOUNT_ID, ate: "2026-09-15T15:00:00.000Z", limite: LIMITE },
      },
    ]);
  });

  it("repetir o pedaço não relê o que já ganhou o user product", async () => {
    const { db } = fakeDb({
      orders: [{ id: 9004, date_created: "2026-09-16T14:30:00.000Z" }],
      items: [item(9004, "MLB4")],
    });
    const { client, calls } = fakeClient({ 9004: pedidoDoMl(9004, "MLB4", "MLBU444") });

    await run(db, client);
    await run(db, client);

    expect(calls).toEqual(["/orders/9004"]);
  });

  it("404 e o 403 do PolicyAgent pulam o pedido; o item que mudou de posição não é tocado", async () => {
    const { db, items } = fakeDb({
      orders: [
        { id: 9001, date_created: "2026-09-16T10:00:00.000Z" },
        { id: 9002, date_created: "2026-09-16T11:00:00.000Z" },
        { id: 9003, date_created: "2026-09-16T12:00:00.000Z" },
        { id: 9004, date_created: "2026-09-16T13:00:00.000Z" },
      ],
      items: [item(9001, "MLB1"), item(9002, "MLB2"), item(9003, "MLB3"), item(9004, "MLB4")],
      links: [link("l-up4", "sku-4", { userProduct: "MLBU444" })],
    });
    const { client, calls } = fakeClient({
      9001: new MercadoLivreApiError("sumiu", { status: 404, errorClass: "not_retryable", url: "x" }),
      9002: new MercadoLivreApiError("política", {
        status: 403,
        errorClass: "not_retryable",
        url: "x",
        body: { code: "PA_UNAUTHORIZED_RESULT_FROM_POLICIES", blocked_by: "PolicyAgent" },
      }),
      9003: pedidoDoMl(9003, "MLB-outro", "MLBU333"),
      9004: pedidoDoMl(9004, "MLB4", "MLBU444"),
    });

    const { outcome, enfileirados, lines } = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(calls).toHaveLength(4);
    expect(items.map((i) => i.sku_id)).toEqual([null, null, null, "sku-4"]);
    expect(items[2]?.user_product_id).toBeNull();
    expect(enfileirados.at(-1)).toMatchObject({ jobType: "backfill.order-user-products" });
    expect(lines.join("\n")).toContain('"leituras_recusadas":2');
    expect(lines.join("\n")).toContain('"divergentes":1');
  });

  it("403 sem corpo é a recusa da instância: o pedaço falha para a fila repetir, e a corrente não avança", async () => {
    const { db, syncRuns } = fakeDb({
      orders: [{ id: 9001, date_created: "2026-09-16T10:00:00.000Z" }],
      items: [item(9001, "MLB1")],
    });
    const { client } = fakeClient({
      9001: new MercadoLivreApiError("recusa", { status: 403, errorClass: "not_retryable", url: "x" }),
    });

    const { outcome, enfileirados } = await run(db, client);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(syncRuns[0]).toMatchObject({ resource: "orders", channel: "backfill", status: "failed" });
    expect(enfileirados).toEqual([]);
  });

  it("429 no meio: o que ganhou SKU fica, o pedaço falha para repetir", async () => {
    const { db, items } = fakeDb({
      orders: [
        { id: 9001, date_created: "2026-09-16T10:00:00.000Z" },
        { id: 9002, date_created: "2026-09-16T11:00:00.000Z" },
      ],
      items: [item(9001, "MLB1"), item(9002, "MLB2")],
      links: [link("l-up1", "sku-1", { userProduct: "MLBU111" })],
    });
    const { client } = fakeClient({
      9001: pedidoDoMl(9001, "MLB1", "MLBU111"),
      9002: new MercadoLivreApiError("limite", { status: 429, errorClass: "retryable", url: "x" }),
    });

    const { outcome, enfileirados } = await run(db, client);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(items.map((i) => i.sku_id)).toEqual(["sku-1", null]);
    expect(enfileirados).toEqual([]);
  });

  it("o último pedaço para no limite; pedaço já no limite, conta desconectada e payload inválido não chamam ninguém", async () => {
    const ultimo = fakeDb({ orders: [] });
    const { client, calls } = fakeClient({});

    const fim = await run(ultimo.db, client, { mlAccountId: ML_ACCOUNT_ID, ate: "2026-06-25T20:00:00.000Z", limite: LIMITE });

    expect(fim.outcome).toEqual({ status: "done", processed: 0 });
    expect(ultimo.filtrosDePedidos.gte).toBe(LIMITE);
    expect(fim.enfileirados).toEqual([]);

    const noLimite = await run(fakeDb({}).db, client, { mlAccountId: ML_ACCOUNT_ID, ate: LIMITE, limite: LIMITE });
    const desconectada = await run(fakeDb({ accountStatus: "ERROR" }).db, client);
    const invalido = await run(fakeDb({}).db, client, { mlAccountId: ML_ACCOUNT_ID });

    expect(noLimite.outcome).toEqual({ status: "done", processed: 0 });
    expect(desconectada.outcome).toEqual({ status: "done", processed: 0 });
    expect(desconectada.enfileirados).toEqual([]);
    expect(invalido.outcome).toMatchObject({ status: "failed", retryable: false });
    expect(calls).toEqual([]);
  });
});
