import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { SyncFulfillmentSnapshotDeps } from "./sync-fulfillment-snapshot.js";
import { createSyncFulfillmentSnapshotHandler } from "./sync-fulfillment-snapshot.js";

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ENCRYPTION_KEY = randomBytes(32);
const NOW = new Date("2026-08-22T14:00:00.000Z");

const OAUTH_CONFIG = { clientId: "APP_ID_123", clientSecret: "segredo-de-teste", redirectUri: "" };

const ENVELOPE = {
  jobType: "sync.fulfillment.snapshot",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
  organizationId: ORGANIZATION_ID,
  dedupeKey: "full:loja-1:2026-08-22T14",
  attempt: 1,
  enqueuedAt: "2026-08-22T14:00:00.000Z",
};

/** Fake mínimo, encadeável e thenable — mesmo espírito de sync-orders-window.test.ts. */
function chain<T>(result: T): {
  eq: () => ReturnType<typeof chain<T>>;
  in: () => ReturnType<typeof chain<T>>;
  is: () => ReturnType<typeof chain<T>>;
  or: () => ReturnType<typeof chain<T>>;
  order: () => ReturnType<typeof chain<T>>;
  limit: () => ReturnType<typeof chain<T>>;
  select: () => ReturnType<typeof chain<T>>;
  range: (from: number, to: number) => Promise<T>;
  maybeSingle: () => Promise<T>;
  then: <R>(resolve: (value: T) => R) => Promise<R>;
} {
  const self = {
    eq: () => self,
    in: () => self,
    is: () => self,
    or: () => self,
    order: () => self,
    limit: () => self,
    select: () => self,
    // Fatia de verdade: `fetchFulfillmentSnapshots` pagina desde D-131, e um
    // fake que ignorasse `range` devolveria a lista inteira em toda janela —
    // laço infinito, ou pior, um teste verde sobre código quebrado.
    range: (from: number, to: number) => {
      const envelope = result as { data?: unknown };

      if (Array.isArray(envelope.data)) {
        return Promise.resolve({ ...(result as object), data: envelope.data.slice(from, to + 1) } as T);
      }

      return Promise.resolve(result);
    },
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
  /** Linhas de `fulfillment_item_absences` (marca de 404/403 anterior). */
  absences?: { item_id: string; failures: number; first_failed_at: string; recheck_after: string }[];
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
  db: SyncFulfillmentSnapshotDeps["db"];
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

        if (table === "fulfillment_item_absences") {
          return chain({ data: options.absences ?? [], error: null });
        }

        // fulfillment_stock_snapshots (previous lookup) — sempre "nunca visto".
        return chain({ data: [], error: null });
      },
      insert: (row: unknown) => {
        inserted.push({ table, row });

        return chain({ data: { id: "run-1" }, error: null });
      },
      // upsert espelha insert: domain_events/stock_movements passaram a
      // gravar por ON CONFLICT DO NOTHING (D-092).
      upsert: (row: unknown) => {
        inserted.push({ table, row });

        return chain({ data: { id: "run-1" }, error: null });
      },
      update: () => chain({ data: { ml_account_id: ML_ACCOUNT_ID }, error: null }),
    }),
  } as unknown as SyncFulfillmentSnapshotDeps["db"];

  return { db, inserted };
}

function fakeMercadoLivreClient(
  itemsById: Record<string, { id: string; inventory_id: string | null }>,
  stockByInventoryId: Record<string, { inventory_id: string; available_quantity: number }>,
): { client: MercadoLivreClient; requests: RequestOptions<unknown>[] } {
  const requests: RequestOptions<unknown>[] = [];

  const client = {
    request: (options: RequestOptions<unknown>) => {
      requests.push(options);

      const itemMatch = /^\/items\/(.+)$/.exec(options.path);

      if (itemMatch?.[1] !== undefined) {
        return Promise.resolve(itemsById[itemMatch[1]] ?? { id: itemMatch[1], inventory_id: null });
      }

      const stockMatch = /^\/inventories\/(.+)\/stock\/fulfillment$/.exec(options.path);

      if (stockMatch?.[1] !== undefined) {
        return Promise.resolve(stockByInventoryId[stockMatch[1]] ?? { inventory_id: stockMatch[1], available_quantity: 0 });
      }

      throw new Error(`caminho inesperado no fake: ${options.path}`);
    },
  } as unknown as MercadoLivreClient;

  return { client, requests };
}

function deps(
  dbOptions: FakeDbOptions,
  itemsById: Record<string, { id: string; inventory_id: string | null }> = {},
  stockByInventoryId: Record<string, { inventory_id: string; available_quantity: number }> = {},
): {
  deps: SyncFulfillmentSnapshotDeps;
  db: ReturnType<typeof fakeDb>;
  requests: RequestOptions<unknown>[];
  lines: string[];
} {
  const db = fakeDb(dbOptions);
  const { client, requests } = fakeMercadoLivreClient(itemsById, stockByInventoryId);
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

function run(d: SyncFulfillmentSnapshotDeps, lines: string[], mlAccountId = ML_ACCOUNT_ID) {
  const handler = createSyncFulfillmentSnapshotHandler(d);

  return handler(ENVELOPE, {
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    payload: { mlAccountId },
  });
}

describe("sync.fulfillment.snapshot", () => {
  it("payload sem mlAccountId falha sem retry", async () => {
    const { deps: d, lines } = deps({});
    const handler = createSyncFulfillmentSnapshotHandler(d);

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
    expect(syncRun?.row).toMatchObject({ status: "failed", resource: "fulfillment", channel: "reconciliation" });
    expect(db.inserted.find((e) => e.table === "sync_errors")?.row).toMatchObject({ error_class: "not_retryable" });
  });

  it("captura com sucesso: done, items_processed correto, sync_runs status done mesmo com itens pulados", async () => {
    const { deps: d, db, lines } = deps(
      { links: [{ item_id: "MLB1", sku_id: "sku-1" }, { item_id: "MLB2", sku_id: "sku-2" }] },
      { MLB1: { id: "MLB1", inventory_id: "INV-1" }, MLB2: { id: "MLB2", inventory_id: null } },
      { "INV-1": { inventory_id: "INV-1", available_quantity: 4 } },
    );

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    const syncRun = db.inserted.find((e) => e.table === "sync_runs")?.row;
    expect(syncRun).toMatchObject({ status: "done", items_processed: 1, resource: "fulfillment" });
  });

  it("erro retryable do Mercado Livre: falha retryable e registra sync_errors com a classe certa", async () => {
    const { deps: d, db, lines } = deps({ links: [{ item_id: "MLB1", sku_id: "sku-1" }] });
    d.mercadoLivre.request = () =>
      Promise.reject(new MercadoLivreApiError("indisponível", { status: 503, errorClass: "retryable", url: "x" }));

    const outcome = await run(d, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(db.inserted.find((e) => e.table === "sync_errors")?.row).toMatchObject({ error_class: "retryable" });
  });

  it("404 num item específico (achado em produção): NÃO derruba o job — vira partial, itemsFailed no reason", async () => {
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

  describe("captura zero com item fora do ar: fulfillment_snapshot_zero_capture", () => {
    // 16/09/2026 21:00 UTC, produção: 403 em todos os 3.220 itens das quatro
    // contas, as quatro terminaram `done` com `processed = 0`, e nada nomeava
    // "o Full desta conta ficou sem captura". O aviso dá nome ao silêncio sem
    // mudar status nem retry.
    function forbidden(): Promise<never> {
      return Promise.reject(
        new MercadoLivreApiError("Mercado Livre respondeu 403 para GET /items/x.", {
          status: 403,
          errorClass: "not_retryable",
          url: "x",
        }),
      );
    }

    const warnOf = (lines: string[]) => lines.find((line) => line.includes("fulfillment_snapshot_zero_capture"));

    it("403 em todos os itens: avisa, e o desfecho continua done/0 — sem retry, sync_runs partial", async () => {
      const { deps: d, db, lines } = deps({
        links: [
          { item_id: "MLB1", sku_id: "sku-1" },
          { item_id: "MLB2", sku_id: "sku-2" },
        ],
      });
      d.mercadoLivre.request = forbidden;

      const outcome = await run(d, lines);

      expect(outcome).toEqual({ status: "done", processed: 0 });
      const warn = warnOf(lines);
      expect(warn).toBeDefined();
      expect(warn).toContain('"severity":"WARNING"');
      expect(warn).toContain('"items_failed":2');
      expect(warn).toContain(`"job_id":"${ENVELOPE.jobId}"`);
      expect(db.inserted.find((e) => e.table === "sync_runs")?.row).toMatchObject({ status: "partial" });
    });

    it("captura zero SEM item fora do ar (conta sem Full): nenhum aviso — é o estado normal", async () => {
      const { deps: d, lines } = deps(
        { links: [{ item_id: "MLB1", sku_id: "sku-1" }] },
        { MLB1: { id: "MLB1", inventory_id: null } },
      );

      const outcome = await run(d, lines);

      expect(outcome).toEqual({ status: "done", processed: 0 });
      expect(warnOf(lines)).toBeUndefined();
    });

    it("captura com item falhando mas outros capturados: nenhum aviso", async () => {
      const { deps: d, lines } = deps({
        links: [
          { item_id: "MLB1", sku_id: "sku-1" },
          { item_id: "MLB2", sku_id: "sku-2" },
        ],
      });
      d.mercadoLivre.request = ((options: RequestOptions<unknown>) => {
        if (options.path === "/items/MLB2") return forbidden();
        if (options.path === "/items/MLB1") return Promise.resolve({ id: "MLB1", inventory_id: "INV-1" });

        return Promise.resolve({ inventory_id: "INV-1", available_quantity: 3 });
      }) as MercadoLivreClient["request"];

      const outcome = await run(d, lines);

      expect(outcome).toEqual({ status: "done", processed: 1 });
      expect(warnOf(lines)).toBeUndefined();
    });

    it("captura zero com os itens só ADIADOS por marca vigente: avisa e fica partial com o motivo do adiamento", async () => {
      const { deps: d, db, requests, lines } = deps({
        links: [{ item_id: "MLB9", sku_id: "sku-9" }],
        absences: [
          {
            item_id: "MLB9",
            failures: 1,
            first_failed_at: NOW.toISOString(),
            recheck_after: new Date(NOW.getTime() + 3_600_000).toISOString(),
          },
        ],
      });

      const outcome = await run(d, lines);

      expect(outcome).toEqual({ status: "done", processed: 0 });
      expect(requests).toHaveLength(0);
      expect(warnOf(lines)).toContain('"items_deferred":1');
      const syncRun = db.inserted.find((e) => e.table === "sync_runs")?.row as { status: string; reason: string | null };
      expect(syncRun.status).toBe("partial");
      expect(syncRun.reason).toBe("1 item(ns) adiado(s) por 404/403 anterior, sem nova consulta");
    });
  });

  it("partial com falha E adiamento na mesma execução: o motivo nomeia os dois", async () => {
    const { deps: d, db, lines } = deps({
      links: [
        { item_id: "MLB1", sku_id: "sku-1" },
        { item_id: "MLB2", sku_id: "sku-2" },
        { item_id: "MLB9", sku_id: "sku-9" },
      ],
      absences: [
        {
          item_id: "MLB9",
          failures: 1,
          first_failed_at: NOW.toISOString(),
          recheck_after: new Date(NOW.getTime() + 3_600_000).toISOString(),
        },
      ],
    });
    d.mercadoLivre.request = ((options: RequestOptions<unknown>) => {
      if (options.path === "/items/MLB2") {
        return Promise.reject(
          new MercadoLivreApiError("Mercado Livre respondeu 404 para GET /items/MLB2.", {
            status: 404,
            errorClass: "not_retryable",
            url: "x",
          }),
        );
      }
      if (options.path === "/items/MLB1") return Promise.resolve({ id: "MLB1", inventory_id: "INV-1" });

      return Promise.resolve({ inventory_id: "INV-1", available_quantity: 3 });
    }) as MercadoLivreClient["request"];

    await run(d, lines);

    const syncRun = db.inserted.find((e) => e.table === "sync_runs")?.row as { status: string; reason: string | null };
    expect(syncRun.status).toBe("partial");
    expect(syncRun.reason).toBe(
      "1 item(ns) falharam ao consultar o Mercado Livre (404/403); 1 item(ns) adiado(s) por 404/403 anterior, sem nova consulta",
    );
    expect(lines.find((line) => line.includes("sync_fulfillment_snapshot_done"))).toContain('"items_deferred":1');
  });

  it("nunca loga access_token, refresh_token nem client_secret", async () => {
    const { deps: d, lines } = deps(
      { links: [{ item_id: "MLB1", sku_id: "sku-1" }] },
      { MLB1: { id: "MLB1", inventory_id: "INV-1" } },
      { "INV-1": { inventory_id: "INV-1", available_quantity: 1 } },
    );

    await run(d, lines);

    const joined = lines.join("\n");
    expect(joined).not.toContain("APP_USR-valido");
    expect(joined).not.toContain("TG-valido");
    expect(joined).not.toContain(OAUTH_CONFIG.clientSecret);
  });
});
