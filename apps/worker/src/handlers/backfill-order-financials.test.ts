import { randomBytes } from "node:crypto";

import { MercadoLivreApiError, encryptToken } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { EnqueueRequest } from "../enqueue.js";
import type { BackfillOrderFinancialsDeps } from "./backfill-order-financials.js";
import { createBackfillOrderFinancialsHandler } from "./backfill-order-financials.js";

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ENCRYPTION_KEY = randomBytes(32);
const NOW = new Date("2026-09-23T15:00:00.000Z");

const ATE = "2026-09-16T15:00:00.000Z";
const LIMITE = "2026-06-25T15:00:00.000Z";

const ENVELOPE = {
  jobType: "backfill.order-financials",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b56",
  organizationId: ORGANIZATION_ID,
  dedupeKey: "backfill-order-financials:loja-1:inicio",
  attempt: 1,
  enqueuedAt: NOW.toISOString(),
};

interface OrderRow {
  id: number;
  shipping_id: number | null;
}

function fakeDb(options: { orders?: OrderRow[]; capturedOrderIds?: number[]; accountStatus?: string }): {
  db: BackfillOrderFinancialsDeps["db"];
  upserted: Record<string, unknown>[];
  syncRuns: Record<string, unknown>[];
  filtrosDePedidos: Record<string, unknown>;
} {
  const orders = options.orders ?? [];
  const captured = new Set(options.capturedOrderIds ?? []);
  const upserted: Record<string, unknown>[] = [];
  const syncRuns: Record<string, unknown>[] = [];
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
            slug: "loja-1",
            status: options.accountStatus ?? "CONNECTED",
          });
        }

        if (table === "ml_credentials") {
          return singleChain(credentials);
        }

        if (table === "orders") {
          return pedidos();
        }

        if (table === "order_financials") {
          // O checkpoint do pedaço: pelos ids, em lotes.
          return {
            in: (_coluna: string, ids: number[]) =>
              Promise.resolve({
                data: ids.filter((id) => captured.has(id)).map((order_id) => ({ order_id })),
                error: null,
              }),
          };
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
  } as unknown as BackfillOrderFinancialsDeps["db"];

  return { db, upserted, syncRuns, filtrosDePedidos };
}

function fakeClient(options: { costsError?: MercadoLivreApiError; falharNoPedido?: number } = {}): {
  client: MercadoLivreClient;
  calls: string[];
} {
  const calls: string[] = [];

  const client = {
    request: (request: RequestOptions<unknown>) => {
      calls.push(request.path);

      if (request.path.includes("/costs")) {
        if (options.costsError !== undefined && request.path.includes(String(options.falharNoPedido ?? ""))) {
          return Promise.reject(options.costsError);
        }

        return Promise.resolve(request.schema.parse({ senders: [{ cost: 18.9 }] }));
      }

      return Promise.resolve(request.schema.parse({ details: [] }));
    },
  } as unknown as MercadoLivreClient;

  return { client, calls };
}

function run(
  db: BackfillOrderFinancialsDeps["db"],
  client: MercadoLivreClient,
  payload: Record<string, unknown> = { mlAccountId: ML_ACCOUNT_ID, ate: ATE, limite: LIMITE },
) {
  const enfileirados: EnqueueRequest[] = [];
  const handler = createBackfillOrderFinancialsHandler({
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
    } as BackfillOrderFinancialsDeps["enqueuer"],
  });

  const lines: string[] = [];

  return handler(ENVELOPE, { logger: createLogger({}, { sink: (line) => lines.push(line) }), payload }).then(
    (outcome) => ({ outcome, enfileirados }),
  );
}

describe("backfill.order-financials (D-396)", () => {
  it("um dia por pedaço: captura o que falta, pula o que já existe e enfileira o dia anterior", async () => {
    const { db, upserted, syncRuns, filtrosDePedidos } = fakeDb({
      orders: [
        { id: 9001, shipping_id: 5001 },
        { id: 9002, shipping_id: 5002 },
        { id: 9003, shipping_id: 5003 },
      ],
      capturedOrderIds: [9002],
    });
    const { client, calls } = fakeClient();

    const { outcome, enfileirados } = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 2 });
    // O pedaço é [ate − 1 dia, ate).
    expect(filtrosDePedidos).toEqual({ gte: "2026-09-15T15:00:00.000Z", lt: ATE });
    expect(calls).toEqual([
      "/shipments/5001/costs",
      "/orders/9001/discounts",
      "/shipments/5003/costs",
      "/orders/9003/discounts",
    ]);
    expect(upserted.map((row) => [row.order_id, row.seller_shipping_cost, row.seller_discount])).toEqual([
      [9001, 18.9, 0],
      [9003, 18.9, 0],
    ]);
    expect(syncRuns[0]).toMatchObject({ resource: "order_financials", channel: "backfill" });
    expect(enfileirados).toEqual([
      {
        jobType: "backfill.order-financials",
        organizationId: ORGANIZATION_ID,
        dedupeKey: "backfill-order-financials:loja-1:2026-09-15T15:00:00.000Z",
        queue: "backfill",
        payload: { mlAccountId: ML_ACCOUNT_ID, ate: "2026-09-15T15:00:00.000Z", limite: LIMITE },
      },
    ]);
  });

  it("o último pedaço para no limite e não enfileira mais nada", async () => {
    const { db, filtrosDePedidos } = fakeDb({ orders: [{ id: 9001, shipping_id: 5001 }] });
    const { client } = fakeClient();

    const { outcome, enfileirados } = await run(db, client, {
      mlAccountId: ML_ACCOUNT_ID,
      ate: "2026-06-25T20:00:00.000Z",
      limite: LIMITE,
    });

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(filtrosDePedidos.gte).toBe(LIMITE);
    expect(enfileirados).toEqual([]);
  });

  it("pedaço já no limite termina sem chamar ninguém", async () => {
    const { db } = fakeDb({ orders: [{ id: 9001, shipping_id: 5001 }] });
    const { client, calls } = fakeClient();

    const { outcome, enfileirados } = await run(db, client, { mlAccountId: ML_ACCOUNT_ID, ate: LIMITE, limite: LIMITE });

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(calls).toEqual([]);
    expect(enfileirados).toEqual([]);
  });

  it("conta desconectada encerra a corrente sem erro", async () => {
    const { db } = fakeDb({ orders: [{ id: 9001, shipping_id: 5001 }], accountStatus: "ERROR" });
    const { client, calls } = fakeClient();

    const { outcome, enfileirados } = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(calls).toEqual([]);
    expect(enfileirados).toEqual([]);
  });

  it("429 no meio: o que foi gravado fica, o pedaço falha para repetir e a corrente não avança", async () => {
    const { db, upserted, syncRuns } = fakeDb({
      orders: [
        { id: 9001, shipping_id: 5001 },
        { id: 9002, shipping_id: 5002 },
      ],
    });
    const { client } = fakeClient({
      costsError: new MercadoLivreApiError("limite", { status: 429, errorClass: "retryable", url: "x" }),
      falharNoPedido: 5002,
    });

    const { outcome, enfileirados } = await run(db, client);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(upserted.map((row) => row.order_id)).toEqual([9001]);
    expect(syncRuns[0]).toMatchObject({ channel: "backfill" });
    expect(enfileirados).toEqual([]);
  });

  it("payload sem as datas é recusado sem repetir", async () => {
    const { db } = fakeDb({});
    const { client } = fakeClient();

    const { outcome } = await run(db, client, { mlAccountId: ML_ACCOUNT_ID });

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });
});
