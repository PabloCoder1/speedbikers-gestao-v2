import { randomBytes } from "node:crypto";

import { MercadoLivreApiError, encryptToken } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { SyncOrderFinancialsDeps } from "./sync-order-financials.js";
import { createSyncOrderFinancialsHandler } from "./sync-order-financials.js";

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ENCRYPTION_KEY = randomBytes(32);
const NOW = new Date("2026-08-31T12:30:00.000Z");

const ENVELOPE = {
  jobType: "sync.order-financials",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b55",
  organizationId: ORGANIZATION_ID,
  dedupeKey: "order-financials:loja-1:2026-08-31",
  attempt: 1,
  enqueuedAt: NOW.toISOString(),
};

interface OrderRow {
  id: number;
  shipping_id: number | null;
}

/** Fake range-aware — as duas leituras passam por `readAllPages` (D-131/D-156). */
function fakeDb(options: {
  orders?: OrderRow[];
  capturedOrderIds?: number[];
  accountStatus?: string;
}): {
  db: SyncOrderFinancialsDeps["db"];
  upserted: Record<string, unknown>[];
  syncRuns: Record<string, unknown>[];
} {
  const orders = options.orders ?? [];
  const capturedRows = (options.capturedOrderIds ?? []).map((order_id) => ({ order_id }));
  const upserted: Record<string, unknown>[] = [];
  const syncRuns: Record<string, unknown>[] = [];

  const credentials = {
    access_token_ciphertext: encryptToken("APP_USR-valido", ENCRYPTION_KEY),
    refresh_token_ciphertext: encryptToken("TG-valido", ENCRYPTION_KEY),
    access_token_expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
  };

  function rangeChain(rows: unknown[]): unknown {
    const self = {
      eq: () => self,
      in: () => self,
      gte: () => self,
      order: () => self,
      range: (from: number, to: number) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }),
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
    from: (table: string) => ({
      select: () => {
        if (table === "ml_accounts") {
          return singleChain({
            id: ML_ACCOUNT_ID,
            organization_id: ORGANIZATION_ID,
            status: options.accountStatus ?? "CONNECTED",
          });
        }

        if (table === "ml_credentials") {
          return singleChain(credentials);
        }

        if (table === "orders") {
          return rangeChain(orders);
        }

        if (table === "order_financials") {
          return rangeChain(capturedRows);
        }

        return singleChain(null);
      },
      upsert: (row: Record<string, unknown>) => {
        upserted.push(row);

        return Promise.resolve({ error: null });
      },
      insert: (row: Record<string, unknown>) => {
        if (table === "sync_runs") {
          syncRuns.push(row);
        }

        return singleChain({ id: "run-1" });
      },
    }),
  } as unknown as SyncOrderFinancialsDeps["db"];

  return { db, upserted, syncRuns };
}

interface FakeClientOptions {
  costsBySender?: number[];
  costsError?: MercadoLivreApiError;
  discountsError?: MercadoLivreApiError;
  sellerDiscount?: number;
}

function fakeClient(options: FakeClientOptions = {}): {
  client: MercadoLivreClient;
  calls: string[];
} {
  const calls: string[] = [];

  const client = {
    request: (request: RequestOptions<unknown>) => {
      calls.push(request.path);

      if (request.path.includes("/costs")) {
        if (options.costsError !== undefined) {
          return Promise.reject(options.costsError);
        }

        return Promise.resolve(
          request.schema.parse({ senders: (options.costsBySender ?? [12.5]).map((cost) => ({ cost })) }),
        );
      }

      if (options.discountsError !== undefined) {
        return Promise.reject(options.discountsError);
      }

      return Promise.resolve(request.schema.parse({ amounts: { seller: options.sellerDiscount ?? 3.75 } }));
    },
  } as unknown as MercadoLivreClient;

  return { client, calls };
}

function run(db: SyncOrderFinancialsDeps["db"], client: MercadoLivreClient, sleeps: number[] = []) {
  const handler = createSyncOrderFinancialsHandler({
    db,
    mercadoLivre: client,
    oauth: { clientId: "APP_ID", clientSecret: "segredo", redirectUri: "" },
    encryptionKey: ENCRYPTION_KEY,
    now: () => NOW,
    sleep: (ms) => {
      sleeps.push(ms);

      return Promise.resolve();
    },
  });

  const lines: string[] = [];

  return handler(ENVELOPE, {
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    payload: { mlAccountId: ML_ACCOUNT_ID },
  });
}

describe("sync.order-financials (D-165)", () => {
  it("caminho feliz: frete somado dos senders + desconto do vendedor, uma linha por pedido", async () => {
    const { db, upserted, syncRuns } = fakeDb({ orders: [{ id: 9001, shipping_id: 5001 }] });
    const { client, calls } = fakeClient({ costsBySender: [10, 2.5] });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(calls).toEqual(["/shipments/5001/costs", "/orders/9001/discounts"]);
    expect(upserted).toEqual([
      expect.objectContaining({
        order_id: 9001,
        seller_shipping_cost: 12.5,
        seller_discount: 3.75,
      }),
    ]);
    expect(syncRuns[0]).toMatchObject({ resource: "order_financials", status: "done", items_processed: 1 });
  });

  it("pedido SEM shipping_id (anterior a D-165): frete NULO declarado, desconto ainda capturado", async () => {
    const { db, upserted } = fakeDb({ orders: [{ id: 9002, shipping_id: null }] });
    const { client, calls } = fakeClient();

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(calls).toEqual(["/orders/9002/discounts"]);
    expect(upserted[0]).toMatchObject({ seller_shipping_cost: null, seller_discount: 3.75 });
  });

  it("4xx definitivo num custo NÃO vira zero nem derruba: campo NULO, pedido registrado", async () => {
    const { db, upserted } = fakeDb({ orders: [{ id: 9003, shipping_id: 5003 }] });
    const { client } = fakeClient({
      costsError: new MercadoLivreApiError("404", { status: 404, errorClass: "not_retryable", url: "x" }),
    });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(upserted[0]).toMatchObject({ seller_shipping_cost: null, seller_discount: 3.75 });
  });

  it("checkpoint (lição D-156): pedido já capturado é pulado sem NENHUMA chamada", async () => {
    const { db, upserted } = fakeDb({
      orders: [{ id: 9004, shipping_id: 5004 }, { id: 9005, shipping_id: 5005 }],
      capturedOrderIds: [9004],
    });
    const { client, calls } = fakeClient();

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(calls).toEqual(["/shipments/5005/costs", "/orders/9005/discounts"]);
    expect(upserted).toHaveLength(1);
  });

  it("espaçamento entre PEDIDOS, nunca antes do primeiro — pulado não paga espera", async () => {
    const sleeps: number[] = [];
    const { db } = fakeDb({
      orders: [
        { id: 9006, shipping_id: null },
        { id: 9007, shipping_id: null },
        { id: 9008, shipping_id: null },
      ],
      capturedOrderIds: [9006],
    });
    const { client } = fakeClient();

    await run(db, client, sleeps);

    expect(sleeps).toEqual([150]);
  });

  it("429 esgotado no MEIO: o progresso anterior fica, sync_run registra a falha, job re-tenta", async () => {
    const { db, upserted, syncRuns } = fakeDb({
      orders: [{ id: 9009, shipping_id: null }, { id: 9010, shipping_id: 5010 }],
    });
    const { client } = fakeClient({
      costsError: new MercadoLivreApiError("rate limited", { status: 429, errorClass: "retryable", url: "x" }),
    });

    const outcome = await run(db, client);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    // O pedido 9009 (sem frete) completou ANTES do 429 do 9010.
    expect(upserted).toHaveLength(1);
    expect(upserted[0]).toMatchObject({ order_id: 9009 });
    expect(syncRuns[0]).toMatchObject({ resource: "order_financials", status: "failed" });
  });

  it("conta não CONNECTED: done sem processar", async () => {
    const { db, upserted } = fakeDb({ accountStatus: "REVOKED" });
    const { client, calls } = fakeClient();

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(upserted).toHaveLength(0);
    expect(calls).toEqual([]);
  });
});
