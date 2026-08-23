import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { SyncListingsSnapshotDeps } from "./sync-listings-snapshot.js";
import { createSyncListingsSnapshotHandler } from "./sync-listings-snapshot.js";

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ENCRYPTION_KEY = randomBytes(32);
const NOW = new Date("2026-08-23T18:00:00.000Z");

const OAUTH_CONFIG = { clientId: "APP_ID_123", clientSecret: "segredo-de-teste", redirectUri: "" };

const ENVELOPE = {
  jobType: "sync.listings.snapshot",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
  organizationId: ORGANIZATION_ID,
  dedupeKey: "listings:loja-1:2026-08-23T18",
  attempt: 1,
  enqueuedAt: "2026-08-23T18:00:00.000Z",
};

/** Fake mínimo, encadeável e thenable — mesmo espírito de sync-fulfillment-snapshot.test.ts. */
function chain<T>(result: T): {
  eq: () => ReturnType<typeof chain<T>>;
  is: () => ReturnType<typeof chain<T>>;
  select: () => ReturnType<typeof chain<T>>;
  maybeSingle: () => Promise<T>;
  then: <R>(resolve: (value: T) => R) => Promise<R>;
} {
  const self = {
    eq: () => self,
    is: () => self,
    select: () => self,
    maybeSingle: () => Promise.resolve(result),
    then: <R>(resolve: (value: T) => R) => Promise.resolve(result).then(resolve),
  };

  return self;
}

interface FakeDbOptions {
  account?: { id: string; organization_id: string; status: string } | null;
  credentials?: {
    access_token_ciphertext: string;
    refresh_token_ciphertext: string;
    access_token_expires_at: string;
  } | null;
  links?: { item_id: string | null; sku_id: string }[];
}

const DEFAULT_ACCOUNT = { id: ML_ACCOUNT_ID, organization_id: ORGANIZATION_ID, status: "CONNECTED" };

function validCredentials(now: Date): NonNullable<FakeDbOptions["credentials"]> {
  return {
    access_token_ciphertext: encryptToken("APP_USR-valido", ENCRYPTION_KEY),
    refresh_token_ciphertext: encryptToken("TG-valido", ENCRYPTION_KEY),
    access_token_expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
  };
}

function fakeDb(options: FakeDbOptions = {}): {
  db: SyncListingsSnapshotDeps["db"];
  inserted: { table: string; row: unknown }[];
} {
  const account = "account" in options ? options.account : DEFAULT_ACCOUNT;
  const credentials = "credentials" in options ? options.credentials : validCredentials(NOW);
  const links = options.links ?? [];

  const inserted: { table: string; row: unknown }[] = [];

  const db = {
    from: (table: string) => ({
      select: () => {
        if (table === "ml_accounts") {
          return chain({ data: account ?? null, error: null });
        }

        if (table === "ml_credentials") {
          return chain({ data: credentials ?? null, error: null });
        }

        if (table === "sku_listing_links") {
          return chain({ data: links, error: null });
        }

        return chain({ data: null, error: null });
      },
      insert: (row: unknown) => {
        inserted.push({ table, row });

        return chain({ data: { id: "run-1" }, error: null });
      },
      upsert: (row: unknown) => {
        inserted.push({ table, row });

        return Promise.resolve({ data: null, error: null });
      },
      update: () => chain({ data: { ml_account_id: ML_ACCOUNT_ID }, error: null }),
    }),
  } as unknown as SyncListingsSnapshotDeps["db"];

  return { db, inserted };
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

function deps(
  dbOptions: FakeDbOptions,
  itemsById: Record<string, Record<string, unknown>> = {},
): {
  deps: SyncListingsSnapshotDeps;
  db: ReturnType<typeof fakeDb>;
  requests: RequestOptions<unknown>[];
  lines: string[];
} {
  const db = fakeDb(dbOptions);
  const { client, requests } = fakeMercadoLivreClient(itemsById);
  const lines: string[] = [];

  return {
    db,
    requests,
    lines,
    deps: {
      db: db.db,
      mercadoLivre: client,
      oauth: OAUTH_CONFIG,
      encryptionKey: ENCRYPTION_KEY,
      now: () => NOW,
    },
  };
}

function run(d: SyncListingsSnapshotDeps, lines: string[], mlAccountId = ML_ACCOUNT_ID) {
  const handler = createSyncListingsSnapshotHandler(d);

  return handler(ENVELOPE, {
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    payload: { mlAccountId },
  });
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

describe("sync.listings.snapshot (D-058)", () => {
  it("payload sem mlAccountId falha sem retry", async () => {
    const { deps: d, lines } = deps({});
    const handler = createSyncListingsSnapshotHandler(d);

    const outcome = await handler(ENVELOPE, {
      logger: createLogger({}, { sink: (line) => lines.push(line) }),
      payload: {},
    });

    expect(outcome).toEqual({ status: "failed", retryable: false, reason: "payload sem mlAccountId" });
  });

  it("conta inexistente: done sem processar, sem gravar sync_runs", async () => {
    const { deps: d, db, lines } = deps({ account: null });

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(db.inserted).toHaveLength(0);
  });

  it("conta não CONNECTED: done sem processar — corrida benigna, não erro", async () => {
    const { deps: d, db, lines } = deps({ account: { ...DEFAULT_ACCOUNT, status: "REVOKED" } });

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(db.inserted).toHaveLength(0);
  });

  it("conta CONNECTED sem credenciais: falha não retryable e registra em sync_errors", async () => {
    const { deps: d, db, lines } = deps({ credentials: null });

    const outcome = await run(d, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    const syncRun = db.inserted.find((e) => e.table === "sync_runs");
    expect(syncRun?.row).toMatchObject({ status: "failed", resource: "listings", channel: "reconciliation" });
    expect(db.inserted.find((e) => e.table === "sync_errors")?.row).toMatchObject({ error_class: "not_retryable" });
  });

  it("sincronização com sucesso: done, items_processed correto, sync_runs status done", async () => {
    const { deps: d, db, lines } = deps(
      { links: [{ item_id: "MLB1", sku_id: "sku-1" }] },
      { MLB1: ITEM_MLB1 },
    );

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    const syncRun = db.inserted.find((e) => e.table === "sync_runs")?.row;
    expect(syncRun).toMatchObject({ status: "done", items_processed: 1, resource: "listings" });
    const listing = db.inserted.find((e) => e.table === "listings")?.row;
    expect(listing).toMatchObject({ item_id: "MLB1", sku_id: "sku-1", title: "Cabo de freio dianteiro" });
  });

  it("erro retryable do Mercado Livre: falha retryable e registra sync_errors com a classe certa", async () => {
    const { deps: d, db, lines } = deps({ links: [{ item_id: "MLB1", sku_id: "sku-1" }] });
    d.mercadoLivre.request = () =>
      Promise.reject(new MercadoLivreApiError("indisponível", { status: 503, errorClass: "retryable", url: "x" }));

    const outcome = await run(d, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(db.inserted.find((e) => e.table === "sync_errors")?.row).toMatchObject({ error_class: "retryable" });
  });

  it("404 num item específico: NÃO derruba o job — vira partial, itemsFailed no reason", async () => {
    const { deps: d, db, lines } = deps({ links: [{ item_id: "MLB-removido", sku_id: "sku-1" }] });
    d.mercadoLivre.request = () =>
      Promise.reject(
        new MercadoLivreApiError("Mercado Livre respondeu 404 para GET /items/MLB-removido.", {
          status: 404,
          errorClass: "not_retryable",
          url: "x",
        }),
      );

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    const syncRun = db.inserted.find((e) => e.table === "sync_runs")?.row as { status: string; reason: string | null };
    expect(syncRun.status).toBe("partial");
    expect(syncRun.reason).toContain("1");
  });

  it("nunca loga access_token, refresh_token nem client_secret", async () => {
    const { deps: d, lines } = deps({ links: [{ item_id: "MLB1", sku_id: "sku-1" }] }, { MLB1: ITEM_MLB1 });

    await run(d, lines);

    const joined = lines.join("\n");
    expect(joined).not.toContain("APP_USR-valido");
    expect(joined).not.toContain("TG-valido");
    expect(joined).not.toContain(OAUTH_CONFIG.clientSecret);
  });
});
