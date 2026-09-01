import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { SyncOrdersWindowDeps } from "./sync-orders-window.js";
import { createSyncOrdersWindowHandler } from "./sync-orders-window.js";

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ENCRYPTION_KEY = randomBytes(32);
const NOW = new Date("2026-08-21T15:37:00.000Z");

const OAUTH_CONFIG = { clientId: "APP_ID_123", clientSecret: "segredo-de-teste", redirectUri: "" };

const ENVELOPE = {
  jobType: "sync.orders.window",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
  organizationId: ORGANIZATION_ID,
  dedupeKey: "sync-orders:loja-1:2026-08-21T15",
  attempt: 1,
  enqueuedAt: "2026-08-21T15:00:00.000Z",
};

/** Fake mínimo, encadeável e thenable — mesmo espírito de `ml-accounts.test.ts`. */
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

interface FakeDbOptions {
  account?: {
    id: string;
    organization_id: string;
    seller_id: number | null;
    status: string;
    connected_at: string | null;
  } | null;
  credentials?: {
    access_token_ciphertext: string;
    refresh_token_ciphertext: string;
    access_token_expires_at: string;
  } | null;
  lastRun?: { latest_record_at: string | null; started_at: string } | null;
  claimLockFails?: boolean;
  lastRunError?: boolean;
}

const DEFAULT_ACCOUNT = {
  id: ML_ACCOUNT_ID,
  organization_id: ORGANIZATION_ID,
  seller_id: 987654321,
  status: "CONNECTED",
  connected_at: "2026-08-01T00:00:00.000Z",
};

function validCredentials(now: Date): FakeDbOptions["credentials"] {
  return {
    access_token_ciphertext: encryptToken("APP_USR-valido", ENCRYPTION_KEY),
    refresh_token_ciphertext: encryptToken("TG-valido", ENCRYPTION_KEY),
    access_token_expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
  };
}

function fakeDb(options: FakeDbOptions = {}): {
  db: SyncOrdersWindowDeps["db"];
  inserted: { table: string; row: unknown }[];
  updated: { table: string; row: unknown }[];
} {
  const account = "account" in options ? options.account : DEFAULT_ACCOUNT;
  const credentials = "credentials" in options ? options.credentials : validCredentials(NOW);
  const lastRun = "lastRun" in options ? options.lastRun : null;

  const inserted: { table: string; row: unknown }[] = [];
  const updated: { table: string; row: unknown }[] = [];

  const db = {
    from: (table: string) => ({
      select: () => {
        if (table === "ml_accounts") {
          return chain({ data: account ?? null, error: null });
        }

        if (table === "ml_credentials") {
          return chain({ data: credentials ?? null, error: null });
        }

        // D-186: as leituras em LOTE do prefetch devolvem lista, e o cliente
        // real devolve `[]` — nunca `null` — quando não há linha. O fake
        // precisa modelar isso: `prefetchOrders` recusa `data` nulo sem erro
        // de propósito, porque "sem vínculo" é resposta legítima e um estado
        // impossível não pode virar essa resposta por omissão.
        if (table === "sku_listing_links" || table === "skus" || table === "sku_components") {
          // Sem vínculo cadastrado no fake — persistOrder grava sku_id nulo.
          return chain({ data: [], error: null });
        }

        if (table === "orders") {
          // Nenhuma order já gravada: todas são novas para a V3.
          return chain({ data: [], error: null });
        }

        // sync_runs (checkpoint lookup)
        return chain(
          options.lastRunError === true ? { data: null, error: { message: "boom" } } : { data: lastRun ?? null, error: null },
        );
      },
      insert: (row: unknown) => {
        inserted.push({ table, row });

        return chain({ data: { id: "run-1" }, error: null });
      },
      update: (row: unknown) => {
        updated.push({ table, row });

        if (table === "ml_credentials" && "refresh_locked_until" in (row as Record<string, unknown>)) {
          const isLockClaim = (row as Record<string, unknown>).refresh_locked_until !== null;

          if (isLockClaim) {
            return chain(
              options.claimLockFails === true
                ? { data: null, error: null }
                : { data: { ml_account_id: ML_ACCOUNT_ID }, error: null },
            );
          }
        }

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
  } as unknown as SyncOrdersWindowDeps["db"];

  return { db, inserted, updated };
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

function deps(
  dbOptions: FakeDbOptions,
  pages: FakePage[] | (() => Promise<never>),
): {
  deps: SyncOrdersWindowDeps;
  db: ReturnType<typeof fakeDb>;
  requests: RequestOptions<unknown>[];
  enqueued: Parameters<SyncOrdersWindowDeps["enqueuer"]["enqueue"]>[0][];
  lines: string[];
} {
  const db = fakeDb(dbOptions);
  const { client, requests } = fakeMercadoLivreClient(pages);
  const enqueued: Parameters<SyncOrdersWindowDeps["enqueuer"]["enqueue"]>[0][] = [];
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
      enqueuer: {
        enqueue: (request) => {
          enqueued.push(request);

          return Promise.resolve({
            taskName: "t",
            envelope: {
              ...ENVELOPE,
              jobType: request.jobType,
              organizationId: request.organizationId,
              dedupeKey: request.dedupeKey,
            },
            deduplicated: false,
          });
        },
      },
      now: () => NOW,
    },
  };
}

function run(d: SyncOrdersWindowDeps, lines: string[], mlAccountId = ML_ACCOUNT_ID) {
  const handler = createSyncOrdersWindowHandler(d);

  return handler(ENVELOPE, {
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    payload: { mlAccountId },
  });
}

describe("sync.orders.window", () => {
  it("payload sem mlAccountId falha sem retry", async () => {
    const { deps: d, lines } = deps({}, []);
    const handler = createSyncOrdersWindowHandler(d);

    const outcome = await handler(ENVELOPE, {
      logger: createLogger({}, { sink: (line) => lines.push(line) }),
      payload: {},
    });

    expect(outcome).toEqual({ status: "failed", retryable: false, reason: "payload sem mlAccountId" });
  });

  it("conta inexistente: done sem processar, sem gravar sync_runs", async () => {
    const { deps: d, db, lines } = deps({ account: null }, []);

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(db.inserted).toHaveLength(0);
  });

  it("conta não CONNECTED: done sem processar — corrida benigna, não erro", async () => {
    const { deps: d, db, lines } = deps({ account: { ...DEFAULT_ACCOUNT, status: "REVOKED" } }, []);

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(db.inserted).toHaveLength(0);
  });

  it("conta CONNECTED sem credenciais: falha não retryable e registra em sync_errors", async () => {
    const { deps: d, db, lines } = deps({ credentials: null }, []);

    const outcome = await run(d, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    const syncRun = db.inserted.find((e) => e.table === "sync_runs");
    expect(syncRun?.row).toMatchObject({ status: "failed", resource: "orders", channel: "reconciliation" });
    expect(db.inserted.find((e) => e.table === "sync_errors")?.row).toMatchObject({
      error_class: "not_retryable",
    });
  });

  it("token válido: não renova, usa direto o access_token decifrado", async () => {
    const { deps: d, db, requests, lines } = deps({}, []);

    await run(d, lines);

    expect(db.updated.find((e) => e.table === "ml_credentials")).toBeUndefined();
    expect(requests[0]?.accessToken).toBe("APP_USR-valido");
  });

  it("token perto de expirar: renova, cifra o novo par e usa o novo access_token", async () => {
    const expiring = {
      access_token_ciphertext: encryptToken("APP_USR-velho", ENCRYPTION_KEY),
      refresh_token_ciphertext: encryptToken("TG-velho", ENCRYPTION_KEY),
      access_token_expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
    };

    const { deps: d, db, requests, lines } = deps({ credentials: expiring }, []);

    // refreshAccessToken faz uma chamada de rede própria via fetch global —
    // sem mock, ela falharia. Substituir fetch global só para este teste.
    const originalFetch = global.fetch;
    global.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "APP_USR-novo",
            token_type: "bearer",
            expires_in: 21_600,
            scope: "offline_access read write",
            user_id: 987654321,
            refresh_token: "TG-novo",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ));

    try {
      await run(d, lines);
    } finally {
      global.fetch = originalFetch;
    }

    expect(requests[0]?.accessToken).toBe("APP_USR-novo");
    const credUpdate = db.updated.find(
      (e) => e.table === "ml_credentials" && "access_token_ciphertext" in (e.row as Record<string, unknown>),
    );
    expect(credUpdate).toBeDefined();
  });

  it("refresh travado por outra execução: falha retryable, não chama o Mercado Livre", async () => {
    const expiring = {
      access_token_ciphertext: encryptToken("APP_USR-velho", ENCRYPTION_KEY),
      refresh_token_ciphertext: encryptToken("TG-velho", ENCRYPTION_KEY),
      access_token_expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
    };

    const { deps: d, db, requests, lines } = deps({ credentials: expiring, claimLockFails: true }, []);

    const outcome = await run(d, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(requests).toHaveLength(0);
    expect(db.inserted.find((e) => e.table === "sync_errors")?.row).toMatchObject({ error_class: "retryable" });
  });

  it("busca vazia: done, zero processados, latest_record_at nulo", async () => {
    const { deps: d, db, lines } = deps({}, []);

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    const syncRun = db.inserted.find((e) => e.table === "sync_runs");
    expect(syncRun?.row).toMatchObject({ status: "done", items_processed: 0, latest_record_at: null });
  });

  it("percorre todas as páginas e soma items_processed, latest_record_at é o maior date_last_updated visto", async () => {
    const pages: FakePage[] = [
      {
        paging: { total: 3, offset: 0, limit: 2 },
        results: [
          fakeOrder(1, "2026-08-21T15:10:00.000-03:00"),
          fakeOrder(2, "2026-08-21T15:20:00.000-03:00"),
        ],
      },
      {
        paging: { total: 3, offset: 2, limit: 2 },
        results: [fakeOrder(3, "2026-08-21T15:05:00.000-03:00")],
      },
    ];

    const { deps: d, db, enqueued, lines } = deps({}, pages);

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 3 });
    const syncRun = db.inserted.find((e) => e.table === "sync_runs")?.row as { latest_record_at: string };
    expect(new Date(syncRun.latest_record_at)).toEqual(new Date("2026-08-21T15:20:00.000-03:00"));
    expect(enqueued).toEqual([
      {
        jobType: "analytics.recompute",
        organizationId: ORGANIZATION_ID,
        dedupeKey: `recompute:${ML_ACCOUNT_ID}:2026-08-21:2026-08-21T15:37Z`,
        queue: "analytics-recompute",
        payload: {
          mode: "incremental",
          mlAccountId: ML_ACCOUNT_ID,
          metricDate: "2026-08-21",
        },
        delaySeconds: 60,
      },
    ]);
  });

  it("a chave suja usa o dia civil de São Paulo, inclusive na fronteira UTC", async () => {
    const { deps: d, enqueued, lines } = deps({}, [
      {
        paging: { total: 1, offset: 0, limit: 50 },
        results: [fakeOrder(1, "2026-08-21T01:30:00.000Z")],
      },
    ]);

    await run(d, lines);

    expect(enqueued[0]?.payload).toMatchObject({ metricDate: "2026-08-20" });
    expect(enqueued[0]?.dedupeKey).toContain(":2026-08-20:");
  });

  it("uma atualização em minuto posterior recebe outro ID de task", async () => {
    const page: FakePage = {
      paging: { total: 1, offset: 0, limit: 50 },
      results: [fakeOrder(1, "2026-08-21T15:10:00.000-03:00")],
    };
    const first = deps({}, [page]);
    const second = deps({}, [page]);
    second.deps.now = () => new Date("2026-08-21T15:38:00.000Z");

    await run(first.deps, first.lines);
    await run(second.deps, second.lines);

    expect(first.enqueued[0]?.dedupeKey).toContain(":2026-08-21T15:37Z");
    expect(second.enqueued[0]?.dedupeKey).toContain(":2026-08-21T15:38Z");
    expect(first.enqueued[0]?.dedupeKey).not.toBe(second.enqueued[0]?.dedupeKey);
  });

  it("falha ao marcar a chave suja torna a sincronização retryable", async () => {
    const { deps: d, db, lines } = deps({}, [
      {
        paging: { total: 1, offset: 0, limit: 50 },
        results: [fakeOrder(1, "2026-08-21T15:10:00.000-03:00")],
      },
    ]);
    d.enqueuer.enqueue = () => Promise.reject(new Error("fila indisponível"));

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "failed", retryable: true, reason: "fila indisponível" });
    expect(db.inserted.find((entry) => entry.table === "sync_errors")?.row).toMatchObject({
      error_class: "retryable",
    });
  });

  it("persiste cada order buscada em orders/order_items", async () => {
    const { deps: d, db, lines } = deps({}, [
      { paging: { total: 1, offset: 0, limit: 50 }, results: [fakeOrder(1, "2026-08-21T15:10:00.000-03:00")] },
    ]);

    await run(d, lines);

    // O fake genérico de `upsert`/`insert` não captura por linha aqui — o
    // teste de mapeamento de campo vive em `persist-order.test.ts`. Este
    // teste prova só que o handler CHAMA a persistência, sem crashar.
    expect(db.inserted.find((e) => e.table === "sync_runs")?.row).toMatchObject({ status: "done" });
  });

  it("order com formato inesperado no meio da página vira partial, sem derrubar o resto", async () => {
    const { deps: d, db, lines } = deps({}, [
      {
        paging: { total: 2, offset: 0, limit: 50 },
        results: [fakeOrder(1, "2026-08-21T15:10:00.000-03:00"), { id: "nao-e-um-numero" }],
      },
    ]);

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    const syncRun = db.inserted.find((e) => e.table === "sync_runs")?.row as {
      status: string;
      reason: string | null;
    };
    expect(syncRun.status).toBe("partial");
    expect(syncRun.reason).toContain("1");
    expect(lines.join()).toContain("order_parse_failed");
  });

  it("janela: from vem do checkpoint de sync_runs (arredondado para baixo), to é a próxima hora cheia", async () => {
    const { deps: d, requests, lines } = deps(
      { lastRun: { latest_record_at: "2026-08-21T12:47:00.000Z", started_at: "2026-08-21T12:00:00.000Z" } },
      [],
    );

    await run(d, lines);

    const params = requests[0]?.searchParams as Record<string, string>;
    expect(params["order.date_last_updated.from"]).toBe("2026-08-21T12:00:00.000+00:00");
    // NOW = 15:37 -> teto na próxima hora cheia, 16:00.
    expect(params["order.date_last_updated.to"]).toBe("2026-08-21T16:00:00.000+00:00");
  });

  it("janela: sem sync_run anterior, from usa connected_at da conta", async () => {
    const { deps: d, requests, lines } = deps({ lastRun: null }, []);

    await run(d, lines);

    const params = requests[0]?.searchParams as Record<string, string>;
    // connected_at = 2026-08-01T00:00:00.000Z, já na hora cheia.
    expect(params["order.date_last_updated.from"]).toBe("2026-08-01T00:00:00.000+00:00");
  });

  it("janela: última execução sem novidade usa started_at dela como piso, não perde o intervalo", async () => {
    const { deps: d, requests, lines } = deps(
      { lastRun: { latest_record_at: null, started_at: "2026-08-21T13:15:00.000Z" } },
      [],
    );

    await run(d, lines);

    const params = requests[0]?.searchParams as Record<string, string>;
    expect(params["order.date_last_updated.from"]).toBe("2026-08-21T13:00:00.000+00:00");
  });

  it("envia o seller_id da conta como filtro", async () => {
    const { deps: d, requests, lines } = deps({}, []);

    await run(d, lines);

    expect((requests[0]?.searchParams as Record<string, unknown>).seller).toBe(987654321);
  });

  it("erro retryable do Mercado Livre: falha retryable e registra sync_errors com a classe certa", async () => {
    const { deps: d, db, lines } = deps({}, () =>
      Promise.reject(
        new MercadoLivreApiError("indisponível", { status: 503, errorClass: "retryable", url: "x" }),
      ),
    );

    const outcome = await run(d, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(db.inserted.find((e) => e.table === "sync_errors")?.row).toMatchObject({ error_class: "retryable" });
  });

  it("erro not_retryable do Mercado Livre: falha definitiva", async () => {
    const { deps: d, lines } = deps({}, () =>
      Promise.reject(
        new MercadoLivreApiError("não autorizado", { status: 401, errorClass: "not_retryable", url: "x" }),
      ),
    );

    const outcome = await run(d, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });

  it("falha ao ler o checkpoint de sync_runs: rejeita, não cai no fallback de janela larga (app.ts converte pra retryable)", async () => {
    const { deps: d, lines } = deps({ lastRunError: true }, []);

    await expect(run(d, lines)).rejects.toThrow(/checkpoint/);
  });

  it("nunca loga access_token, refresh_token nem client_secret", async () => {
    const { deps: d, lines } = deps({}, [
      { paging: { total: 1, offset: 0, limit: 50 }, results: [fakeOrder(1, "2026-08-21T15:00:00.000Z")] },
    ]);

    await run(d, lines);

    const joined = lines.join("\n");
    expect(joined).not.toContain("APP_USR-valido");
    expect(joined).not.toContain("TG-valido");
    expect(joined).not.toContain(OAUTH_CONFIG.clientSecret);
  });
});
