import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { EnqueueRequest, EnqueueResult } from "../enqueue.js";
import type { BackfillOrdersDeps } from "./backfill-orders.js";
import { createBackfillOrdersHandler } from "./backfill-orders.js";

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ENCRYPTION_KEY = randomBytes(32);
const NOW = new Date("2026-08-21T15:37:00.000Z");

const OAUTH_CONFIG = { clientId: "APP_ID_123", clientSecret: "segredo-de-teste", redirectUri: "" };

const ENVELOPE = {
  jobType: "backfill.orders",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
  organizationId: ORGANIZATION_ID,
  dedupeKey: "backfill-orders:loja-1:start",
  attempt: 1,
  enqueuedAt: "2026-08-21T15:00:00.000Z",
};

/** Fake mínimo, encadeável e thenable — mesmo espírito de `sync-orders-window.test.ts`. */
function chain<T>(result: T): {
  eq: () => ReturnType<typeof chain<T>>;
  is: () => ReturnType<typeof chain<T>>;
  gt: () => ReturnType<typeof chain<T>>;
  in: () => ReturnType<typeof chain<T>>;
  or: () => ReturnType<typeof chain<T>>;
  order: () => ReturnType<typeof chain<T>>;
  limit: () => ReturnType<typeof chain<T>>;
  select: () => ReturnType<typeof chain<T>>;
  maybeSingle: () => Promise<T>;
  then: <R>(resolve: (value: T) => R) => Promise<R>;
} {
  const self = {
    eq: () => self,
    is: () => self,
    gt: () => self,
    in: () => self,
    or: () => self,
    order: () => self,
    limit: () => self,
    select: () => self,
    maybeSingle: () => Promise.resolve(result),
    then: <R>(resolve: (value: T) => R) => Promise.resolve(result).then(resolve),
  };

  return self;
}

interface FakeAccount {
  id: string;
  organization_id: string;
  slug: string;
  seller_id: number | null;
  status: string;
  connected_at: string | null;
  backfill_covered_until: string | null;
}

const DEFAULT_ACCOUNT: FakeAccount = {
  id: ML_ACCOUNT_ID,
  organization_id: ORGANIZATION_ID,
  slug: "loja-1",
  seller_id: 987654321,
  status: "CONNECTED",
  connected_at: "2026-08-01T00:00:00.000Z",
  backfill_covered_until: null,
};

interface FakeDbOptions {
  account?: FakeAccount | null;
  credentials?: {
    access_token_ciphertext: string;
    refresh_token_ciphertext: string;
    access_token_expires_at: string;
  } | null;
}

function validCredentials(now: Date): NonNullable<FakeDbOptions["credentials"]> {
  return {
    access_token_ciphertext: encryptToken("APP_USR-valido", ENCRYPTION_KEY),
    refresh_token_ciphertext: encryptToken("TG-valido", ENCRYPTION_KEY),
    access_token_expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
  };
}

function fakeDb(options: FakeDbOptions = {}): {
  db: BackfillOrdersDeps["db"];
  updated: { table: string; row: unknown }[];
} {
  const account = "account" in options ? options.account : DEFAULT_ACCOUNT;
  const credentials = "credentials" in options ? options.credentials : validCredentials(NOW);

  const updated: { table: string; row: unknown }[] = [];

  const db = {
    from: (table: string) => ({
      select: () => {
        if (table === "ml_accounts") {
          return chain({ data: account ?? null, error: null });
        }

        // D-186: leitura em LOTE devolve lista. O cliente real devolve `[]`,
        // nunca `null`, quando não há linha — e `prefetchOrders` recusa `data`
        // nulo sem erro de propósito.
        if (table === "sku_listing_links" || table === "skus" || table === "sku_components" || table === "orders") {
          // Sem vínculo cadastrado no fake — persistOrder grava sku_id nulo.
          return chain({ data: [], error: null });
        }

        return chain({ data: credentials ?? null, error: null });
      },
      insert: () => chain({ data: { id: "run-1" }, error: null }),
      update: (row: unknown) => {
        updated.push({ table, row });

        return chain({ data: null, error: null });
      },
      // persistOrder: upsert de `orders`, delete + insert de `order_items`.
      upsert: () => Promise.resolve({ data: null, error: null }),
      // D-189: a exclusão da cauda encadeia `.eq().gte()`, e a cadeia precisa
      // ser thenable em qualquer ponto — outros caminhos ainda usam só `.eq()`.
      delete: () => {
        const cadeia = () => ({
          eq: () => cadeia(),
          gte: () => cadeia(),
          then: <T>(onFulfilled: (value: { data: null; error: null }) => T) =>
            Promise.resolve({ data: null, error: null }).then(onFulfilled),
        });

        return cadeia();
      },
    }),
  } as unknown as BackfillOrdersDeps["db"];

  return { db, updated };
}

interface FakePage {
  paging: { total: number; offset: number; limit: number };
  results: unknown[];
}

/** Order mínima, mas válida contra `orderSchema` — o que `/orders/search` devolve de verdade. */
function fakeOrder(id: number, dateLastUpdated: string): unknown {
  return {
    id,
    status: "paid",
    date_created: dateLastUpdated,
    date_last_updated: dateLastUpdated,
    total_amount: 100,
    currency_id: "BRL",
    order_items: [
      { item: { id: "MLB1", title: "Item" }, quantity: 1, unit_price: 100, currency_id: "BRL" },
    ],
  };
}

function fakeMercadoLivreClient(
  behavior: FakePage[] | (() => Promise<never>),
): { client: MercadoLivreClient; requests: RequestOptions<unknown>[] } {
  const requests: RequestOptions<unknown>[] = [];
  let call = 0;

  const client = {
    request: (options: RequestOptions<unknown>) => {
      requests.push(options);

      if (typeof behavior === "function") {
        return behavior();
      }

      const page = behavior[call] ?? { paging: { total: 0, offset: 0, limit: 50 }, results: [] };

      call += 1;

      return Promise.resolve(page);
    },
  } as unknown as MercadoLivreClient;

  return { client, requests };
}

function fakeEnqueuer(): { enqueuer: BackfillOrdersDeps["enqueuer"]; enqueued: EnqueueRequest[] } {
  const enqueued: EnqueueRequest[] = [];

  return {
    enqueued,
    enqueuer: {
      enqueue: (request: EnqueueRequest): Promise<EnqueueResult> => {
        enqueued.push(request);

        return Promise.resolve({
          taskName: "t",
          deduplicated: false,
          envelope: {
            jobType: request.jobType,
            jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
            organizationId: request.organizationId,
            dedupeKey: request.dedupeKey,
            attempt: 1,
            enqueuedAt: NOW.toISOString(),
          },
        });
      },
    },
  };
}

function deps(
  dbOptions: FakeDbOptions,
  pages: FakePage[] | (() => Promise<never>),
): {
  deps: BackfillOrdersDeps;
  db: ReturnType<typeof fakeDb>;
  requests: RequestOptions<unknown>[];
  enqueued: EnqueueRequest[];
  lines: string[];
} {
  const db = fakeDb(dbOptions);
  const { client, requests } = fakeMercadoLivreClient(pages);
  const { enqueuer, enqueued } = fakeEnqueuer();
  const lines: string[] = [];

  return {
    db,
    requests,
    enqueued,
    lines,
    deps: {
      db: db.db,
      mercadoLivre: client,
      oauth: OAUTH_CONFIG,
      encryptionKey: ENCRYPTION_KEY,
      enqueuer,
      now: () => NOW,
    },
  };
}

function run(d: BackfillOrdersDeps, lines: string[], mlAccountId = ML_ACCOUNT_ID) {
  const handler = createBackfillOrdersHandler(d);

  return handler(ENVELOPE, {
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    payload: { mlAccountId },
  });
}

describe("backfill.orders", () => {
  it("payload sem mlAccountId falha sem retry", async () => {
    const { deps: d, lines } = deps({}, []);
    const handler = createBackfillOrdersHandler(d);

    const outcome = await handler(ENVELOPE, {
      logger: createLogger({}, { sink: (line) => lines.push(line) }),
      payload: {},
    });

    expect(outcome).toEqual({ status: "failed", retryable: false, reason: "payload sem mlAccountId" });
  });

  it("conta inexistente: done sem processar", async () => {
    const { deps: d, enqueued, lines } = deps({ account: null }, []);

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(enqueued).toHaveLength(0);
  });

  it("conta não CONNECTED: done sem processar", async () => {
    const { deps: d, enqueued, lines } = deps({ account: { ...DEFAULT_ACCOUNT, status: "REVOKED" } }, []);

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(enqueued).toHaveLength(0);
  });

  it("backfill já completo (covered_until >= connected_at): done sem buscar nada", async () => {
    const { deps: d, requests, enqueued, lines } = deps(
      { account: { ...DEFAULT_ACCOUNT, backfill_covered_until: "2026-08-05T00:00:00.000Z" } },
      [],
    );

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(requests).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it("primeiro pedaço: sem checkpoint, começa 12 meses atrás", async () => {
    const { deps: d, requests, lines } = deps({}, []);

    await run(d, lines);

    const params = requests[0]?.searchParams as Record<string, string>;
    const expectedFrom = new Date(NOW.getTime() - 365 * 24 * 3_600_000);
    expectedFrom.setUTCMinutes(0, 0, 0);
    expect(params["order.date_last_updated.from"]).toBe(
      expectedFrom.toISOString().replace("Z", "+00:00"),
    );
  });

  it("pedaço não cobre além de connected_at, mesmo pedindo 7 dias", async () => {
    const { deps: d, requests, lines } = deps(
      { account: { ...DEFAULT_ACCOUNT, backfill_covered_until: "2026-07-30T00:00:00.000Z" } },
      [],
    );

    await run(d, lines);

    const params = requests[0]?.searchParams as Record<string, string>;
    // connected_at = 2026-08-01, bem antes de 2026-07-30 + 7 dias.
    expect(params["order.date_last_updated.to"]).toBe("2026-08-01T00:00:00.000+00:00");
  });

  it("sucesso com mais história pendente: avança o checkpoint e enfileira o próximo pedaço", async () => {
    const { deps: d, db, enqueued, lines } = deps(
      { account: { ...DEFAULT_ACCOUNT, connected_at: "2026-12-01T00:00:00.000Z", backfill_covered_until: null } },
      [],
    );

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    const accountUpdate = db.updated.find((e) => e.table === "ml_accounts");
    expect(accountUpdate).toBeDefined();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      jobType: "backfill.orders",
      organizationId: ORGANIZATION_ID,
      queue: "backfill",
      payload: { mlAccountId: ML_ACCOUNT_ID },
    });
    expect(enqueued[0]?.dedupeKey).toMatch(/^backfill-orders:loja-1:/);
  });

  it("sucesso no último pedaço: avança o checkpoint mas não enfileira mais nada", async () => {
    // covered_until a 3 dias de connected_at — um pedaço de 7 dias fecha tudo.
    const { deps: d, db, enqueued, lines } = deps(
      { account: { ...DEFAULT_ACCOUNT, connected_at: "2026-08-01T00:00:00.000Z", backfill_covered_until: "2026-07-29T00:00:00.000Z" } },
      [],
    );

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    const accountUpdate = db.updated.find((e) => e.table === "ml_accounts")?.row as {
      backfill_covered_until: string;
    };
    expect(new Date(accountUpdate.backfill_covered_until).getTime()).toBeGreaterThanOrEqual(
      new Date("2026-08-01T00:00:00.000Z").getTime(),
    );
    expect(enqueued).toHaveLength(0);
  });

  it("soma items_processed através das páginas", async () => {
    const pages: FakePage[] = [
      {
        paging: { total: 2, offset: 0, limit: 50 },
        results: [
          fakeOrder(1, "2026-01-05T10:00:00.000-03:00"),
          fakeOrder(2, "2026-01-06T10:00:00.000-03:00"),
        ],
      },
    ];

    const { deps: d, lines } = deps({}, pages);

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 2 });
  });

  it("conta CONNECTED sem credenciais: falha não retryable, não enfileira o próximo pedaço", async () => {
    const { deps: d, db, enqueued, lines } = deps({ credentials: null }, []);

    const outcome = await run(d, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(db.updated.find((e) => e.table === "ml_accounts")).toBeUndefined();
    expect(enqueued).toHaveLength(0);
  });

  it("erro retryable do Mercado Livre: falha retryable, checkpoint não avança, nada é enfileirado", async () => {
    const { deps: d, db, enqueued, lines } = deps({}, () =>
      Promise.reject(
        new MercadoLivreApiError("indisponível", { status: 503, errorClass: "retryable", url: "x" }),
      ),
    );

    const outcome = await run(d, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(db.updated.find((e) => e.table === "ml_accounts")).toBeUndefined();
    expect(enqueued).toHaveLength(0);
  });

  it("nunca loga access_token, refresh_token nem client_secret", async () => {
    const { deps: d, lines } = deps({}, []);

    await run(d, lines);

    const joined = lines.join("\n");
    expect(joined).not.toContain("APP_USR-valido");
    expect(joined).not.toContain("TG-valido");
    expect(joined).not.toContain(OAUTH_CONFIG.clientSecret);
  });
});
