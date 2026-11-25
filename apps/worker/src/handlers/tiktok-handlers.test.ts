import { randomBytes } from "node:crypto";

import type { JobEnvelope } from "@sb/contracts";
import { encryptToken } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { TikTokShopApiError, type TikTokShopClient } from "@sb/tiktok-shop";
import { describe, expect, it, vi } from "vitest";

import type { Enqueuer } from "../enqueue.js";
import type { TikTokJobDeps } from "./tiktok-comum.js";
import { createTikTokFinancialsSyncHandler } from "./tiktok-financials-sync.js";
import { createTikTokItemsSyncHandler } from "./tiktok-items-sync.js";
import { createTikTokOrderFetchHandler, createTikTokOrdersSyncHandler } from "./tiktok-orders-sync.js";
import type { TikTokSyncRepository } from "./tiktok-repository.js";
import { createTikTokReturnsSyncHandler } from "./tiktok-returns-sync.js";

const KEY = randomBytes(32);
const ORG_A = "11111111-0000-4000-8000-000000000001";
const ORG_B = "22222222-0000-4000-8000-000000000002";
const SHOP_ID = "33333333-0000-4000-8000-000000000003";
const NOW = new Date("2026-11-25T12:00:00.000Z");

function makeEnvelope(jobType: string, organizationId = ORG_A): JobEnvelope {
  return {
    jobId: "44444444-0000-4000-8000-000000000004",
    jobType,
    organizationId,
    dedupeKey: `test:${jobType}`,
    attempt: 1,
    enqueuedAt: NOW.toISOString(),
  };
}

function silentLogger() {
  return createLogger({ service: "worker-test" }, { sink: () => undefined });
}

function makeDb(shopOrgId = ORG_A): TikTokJobDeps["db"] {
  const shopRow = {
    id: SHOP_ID,
    organization_id: shopOrgId,
    shop_id: "7000714532876273420",
    shop_name: "Speed Bikers TikTok",
    region: "BR",
    status: "CONNECTED",
  };
  const credRow = {
    shop_cipher: "TTP_CIPHER_BR",
    access_token_ciphertext: encryptToken("atk_live", KEY),
    refresh_token_ciphertext: encryptToken("rtk_live", KEY),
    access_token_expires_at: "2026-11-26T12:00:00.000Z",
  };

  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: table === "tiktok_shops" ? shopRow : credRow, error: null }),
        }),
      }),
    }),
  } as unknown as TikTokJobDeps["db"];
}

function makeRepository(): TikTokSyncRepository {
  return {
    acquireOrdersLock: vi.fn(() => Promise.resolve({ data: true, error: null })),
    releaseOrdersLock: vi.fn(() => Promise.resolve({ error: null })),
    readOrdersCursor: vi.fn(() => Promise.resolve({ data: "2026-11-24T12:00:00.000Z", error: null })),
    advanceOrdersCursor: vi.fn(() => Promise.resolve({ error: null })),
    upsertOrders: vi.fn(() => Promise.resolve({ error: null })),
    upsertCatalogUnits: vi.fn(() => Promise.resolve({ error: null })),
    upsertReturns: vi.fn(() => Promise.resolve({ error: null })),
    upsertOrderFinancials: vi.fn(() => Promise.resolve({ error: null })),
    upsertStatements: vi.fn(() => Promise.resolve({ error: null })),
  };
}

describe("TikTok Shop worker handlers (D-834)", () => {
  it("todos os 5 handlers recusam loja de outra organização com retryable=false sem acionar repositório", async () => {
    const db = makeDb(ORG_B);
    const repo = makeRepository();
    const request = vi.fn();
    const client = { request } as unknown as TikTokShopClient;
    const enqueuer: Enqueuer = { enqueue: vi.fn() };
    const logger = silentLogger();

    const ordersOutcome = await createTikTokOrdersSyncHandler({ db, client, encryptionKey: KEY, enqueuer, repository: repo, now: () => NOW })(
      makeEnvelope("tiktok.orders.sync", ORG_A),
      { payload: { tiktokShopId: SHOP_ID }, logger },
    );
    const orderFetchOutcome = await createTikTokOrderFetchHandler({ db, client, encryptionKey: KEY, enqueuer, repository: repo, now: () => NOW })(
      makeEnvelope("tiktok.order.fetch", ORG_A),
      { payload: { tiktokShopId: SHOP_ID, orderId: "576460752303423488" }, logger },
    );
    const itemsOutcome = await createTikTokItemsSyncHandler({ db, client, encryptionKey: KEY, repository: repo, now: () => NOW })(
      makeEnvelope("tiktok.items.sync", ORG_A),
      { payload: { tiktokShopId: SHOP_ID }, logger },
    );
    const returnsOutcome = await createTikTokReturnsSyncHandler({ db, client, encryptionKey: KEY, repository: repo, now: () => NOW })(
      makeEnvelope("tiktok.returns.sync", ORG_A),
      { payload: { tiktokShopId: SHOP_ID }, logger },
    );
    const financialsOutcome = await createTikTokFinancialsSyncHandler({ db, client, encryptionKey: KEY, repository: repo, now: () => NOW })(
      makeEnvelope("tiktok.financials.sync", ORG_A),
      { payload: { tiktokShopId: SHOP_ID }, logger },
    );

    const expected = {
      status: "failed",
      retryable: false,
      reason: "loja do TikTok Shop pertence a outra organização",
    };

    expect(ordersOutcome).toEqual(expected);
    expect(orderFetchOutcome).toEqual(expected);
    expect(itemsOutcome).toEqual(expected);
    expect(returnsOutcome).toEqual(expected);
    expect(financialsOutcome).toEqual(expected);
    expect(request).not.toHaveBeenCalled();
    expect(repo.acquireOrdersLock).not.toHaveBeenCalled();
    expect(repo.upsertOrders).not.toHaveBeenCalled();
    expect(repo.upsertCatalogUnits).not.toHaveBeenCalled();
    expect(repo.upsertReturns).not.toHaveBeenCalled();
    expect(repo.upsertStatements).not.toHaveBeenCalled();
  });

  it("tiktok.orders.sync projeta pedidos, avança cursor, solta trava e enfileira financeiro e devoluções", async () => {
    const db = makeDb(ORG_A);
    const repo = makeRepository();
    const enqueue = vi.fn<Enqueuer["enqueue"]>(() =>
      Promise.resolve({ deduplicated: false, taskName: "task-1", envelope: makeEnvelope("tiktok.financials.sync") }),
    );
    const client = {
      request: vi.fn((req: { path: string }) => {
        if (req.path === "/order/202309/orders/search") {
          return Promise.resolve({
            orders: [{ id: "ORD-1", status: "DELIVERED", create_time: 1764000000, update_time: 1764000100 }],
            next_page_token: "",
            total_count: 1,
          });
        }

        return Promise.resolve({
          orders: [
            {
              id: "ORD-1",
              status: "DELIVERED",
              create_time: 1764000000,
              update_time: 1764000100,
              paid_time: 1764000050,
              fulfillment_type: "FULFILLMENT_BY_SELLER",
              payment: { currency: "BRL", sub_total: "199.90", shipping_fee: "15.00", total_amount: "214.90" },
              line_items: [{ id: "LI-1", sku_id: "SKU-1", seller_sku: "CAP-01", product_id: "PROD-1", sale_price: "199.90" }],
            },
          ],
        });
      }),
    } as unknown as TikTokShopClient;

    const handler = createTikTokOrdersSyncHandler({
      db,
      client,
      encryptionKey: KEY,
      enqueuer: { enqueue },
      repository: repo,
      now: () => NOW,
    });

    const outcome = await handler(makeEnvelope("tiktok.orders.sync"), {
      payload: { tiktokShopId: SHOP_ID },
      logger: silentLogger(),
    });

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(repo.upsertOrders).toHaveBeenCalledTimes(1);
    expect(repo.advanceOrdersCursor).toHaveBeenCalledWith(SHOP_ID, NOW.toISOString());
    expect(repo.releaseOrdersLock).toHaveBeenCalledWith(SHOP_ID);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("tiktok.orders.sync não avança cursor quando upsertOrders falha e protege erro de unlock/enqueue", async () => {
    const db = makeDb(ORG_A);
    const repo = makeRepository();

    repo.upsertOrders = vi.fn(() => Promise.resolve({ error: "deadlock detected" }));
    repo.releaseOrdersLock = vi.fn(() => Promise.reject(new Error("ECONNRESET")));

    const client = {
      request: vi.fn((req: { path: string }) => {
        if (req.path === "/order/202309/orders/search") {
          return Promise.resolve({
            orders: [{ id: "ORD-2", status: "AWAITING_SHIPMENT", create_time: 1764000000, update_time: 1764000100 }],
            next_page_token: "",
          });
        }

        return Promise.resolve({
          orders: [
            {
              id: "ORD-2",
              status: "AWAITING_SHIPMENT",
              create_time: 1764000000,
              update_time: 1764000100,
              line_items: [{ id: "LI-2", sku_id: "SKU-2", seller_sku: "LUVA-01", product_id: "PROD-2", sale_price: "89.90" }],
            },
          ],
        });
      }),
    } as unknown as TikTokShopClient;

    const enqueue = vi.fn();
    const handler = createTikTokOrdersSyncHandler({
      db,
      client,
      encryptionKey: KEY,
      enqueuer: { enqueue },
      repository: repo,
      now: () => NOW,
    });

    const outcome = await handler(makeEnvelope("tiktok.orders.sync"), {
      payload: { tiktokShopId: SHOP_ID },
      logger: silentLogger(),
    });

    expect(outcome).toEqual({
      status: "failed",
      retryable: true,
      reason: "falha ao gravar pedidos TikTok: deadlock detected",
    });
    expect(repo.advanceOrdersCursor).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("tiktok.order.fetch persiste pedido pontual e sinaliza retryable=true se enfileirar financeiro falhar", async () => {
    const db = makeDb(ORG_A);
    const repo = makeRepository();
    const enqueue = vi.fn(() => Promise.reject(new Error("tasks unavailable")));
    const client = {
      request: vi.fn(() =>
        Promise.resolve({
          orders: [
            {
              id: "ORD-99",
              status: "COMPLETED",
              create_time: 1764000000,
              update_time: 1764000200,
              line_items: [{ id: "LI-99", sku_id: "SKU-99", seller_sku: "JAQ-01", product_id: "PROD-99", sale_price: "350.00" }],
            },
          ],
        }),
      ),
    } as unknown as TikTokShopClient;

    const outcome = await createTikTokOrderFetchHandler({
      db,
      client,
      encryptionKey: KEY,
      enqueuer: { enqueue },
      repository: repo,
      now: () => NOW,
    })(makeEnvelope("tiktok.order.fetch"), {
      payload: { tiktokShopId: SHOP_ID, orderId: "ORD-99" },
      logger: silentLogger(),
    });

    expect(outcome).toEqual({
      status: "failed",
      retryable: true,
      reason: "falha ao enfileirar financeiro do pedido TikTok: tasks unavailable",
    });
    expect(repo.upsertOrders).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("tiktok.items.sync pagina produtos, aplica override de estoque de searchInventory e persiste", async () => {
    const db = makeDb(ORG_A);
    const repo = makeRepository();
    const client = {
      request: vi.fn((req: { path: string }) => {
        if (req.path === "/product/202502/products/search") {
          return Promise.resolve({
            products: [
              {
                id: "PROD-1",
                title: "Capacete Pro",
                status: "ACTIVATE",
                skus: [{ id: "SKU-1", seller_sku: "cap-01", price: { currency: "BRL", sale_price: "299.90" } }],
              },
            ],
            next_page_token: "",
          });
        }

        return Promise.resolve({
          inventory: [
            {
              product_id: "PROD-1",
              skus: [{ id: "SKU-1", total_available_quantity: 14, total_committed_quantity: 2 }],
            },
          ],
        });
      }),
    } as unknown as TikTokShopClient;

    const outcome = await createTikTokItemsSyncHandler({
      db,
      client,
      encryptionKey: KEY,
      repository: repo,
      now: () => NOW,
    })(makeEnvelope("tiktok.items.sync"), {
      payload: { tiktokShopId: SHOP_ID },
      logger: silentLogger(),
    });

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(repo.upsertCatalogUnits).toHaveBeenCalledWith(
      ORG_A,
      SHOP_ID,
      expect.arrayContaining([
        expect.objectContaining({
          productId: "PROD-1",
          skuId: "SKU-1",
          sellerSkuKey: "CAP-01",
          availableStock: 14,
          committedStock: 2,
        }),
      ]),
    );
  });

  it("tiktok.returns.sync projeta devoluções e persiste idempotentemente", async () => {
    const db = makeDb(ORG_A);
    const repo = makeRepository();
    const client = {
      request: vi.fn(() =>
        Promise.resolve({
          return_orders: [
            {
              return_id: "RET-1",
              order_id: "ORD-1",
              return_type: "RETURN_AND_REFUND",
              return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE",
              create_time: 1764001000,
              update_time: 1764002000,
              return_line_items: [{ product_id: "PROD-1", sku_id: "SKU-1", seller_sku: "CAP-01" }],
            },
          ],
          next_page_token: "",
        }),
      ),
    } as unknown as TikTokShopClient;

    const outcome = await createTikTokReturnsSyncHandler({
      db,
      client,
      encryptionKey: KEY,
      repository: repo,
      now: () => NOW,
    })(makeEnvelope("tiktok.returns.sync"), {
      payload: { tiktokShopId: SHOP_ID },
      logger: silentLogger(),
    });

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(repo.upsertReturns).toHaveBeenCalledTimes(1);
  });

  it("tiktok.financials.sync suporta consulta pontual por orderId e falha definitiva em erro 403", async () => {
    const db = makeDb(ORG_A);
    const repo = makeRepository();
    const clientOk = {
      request: vi.fn(() =>
        Promise.resolve({
          order_id: "ORD-1",
          currency: "BRL",
          settlement_amount: "170.00",
          sku_transactions: [],
        }),
      ),
    } as unknown as TikTokShopClient;

    const ok = await createTikTokFinancialsSyncHandler({
      db,
      client: clientOk,
      encryptionKey: KEY,
      repository: repo,
      now: () => NOW,
    })(makeEnvelope("tiktok.financials.sync"), {
      payload: { tiktokShopId: SHOP_ID, orderId: "ORD-1" },
      logger: silentLogger(),
    });

    expect(ok).toEqual({ status: "done", processed: 1 });
    expect(repo.upsertOrderFinancials).toHaveBeenCalledTimes(1);

    const clientForbidden = {
      request: vi.fn(() =>
        Promise.reject(
          new TikTokShopApiError("scope financeiro ausente", {
            status: 403,
            code: 105005,
            requestId: "req-fin",
            errorClass: "not_retryable",
          }),
        ),
      ),
    } as unknown as TikTokShopClient;

    const fail = await createTikTokFinancialsSyncHandler({
      db,
      client: clientForbidden,
      encryptionKey: KEY,
      repository: repo,
      now: () => NOW,
    })(makeEnvelope("tiktok.financials.sync"), {
      payload: { tiktokShopId: SHOP_ID },
      logger: silentLogger(),
    });

    expect(fail).toEqual({
      status: "failed",
      retryable: false,
      reason: "scope financeiro ausente",
    });
  });
});
