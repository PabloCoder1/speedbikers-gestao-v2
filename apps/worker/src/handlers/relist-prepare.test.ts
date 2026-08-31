import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { RelistPrepareDeps } from "./relist-prepare.js";
import { createRelistPrepareHandler } from "./relist-prepare.js";

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const REQUESTED_BY = "bbbbbbbb-0000-4000-8000-000000000002";
const ITEM_ID = "MLB910000001";
const ENCRYPTION_KEY = randomBytes(32);
const NOW = new Date("2026-08-31T12:00:00.000Z");

const ENVELOPE = {
  jobType: "relist.prepare",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b33",
  organizationId: ORGANIZATION_ID,
  dedupeKey: `relist-prepare:${ITEM_ID}:2026-08-31T12:00`,
  attempt: 1,
  enqueuedAt: NOW.toISOString(),
};

const PAYLOAD = { mlAccountId: ML_ACCOUNT_ID, itemId: ITEM_ID, requestedBy: REQUESTED_BY };

/** Item saudável para o preflight — os testes de bloqueio partem dele. */
function healthyItemBody(): Record<string, unknown> {
  return {
    id: ITEM_ID,
    tags: ["good_quality_picture"],
    catalog_listing: false,
    listing_type_id: "gold_special",
    variations: [],
  };
}

function chain(result: unknown): unknown {
  const self = {
    eq: () => self,
    select: () => self,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };

  return self;
}

interface FakeDbOptions {
  accountStatus?: string;
  relistInsertError?: { code?: string; message: string };
  relistUpdateError?: { message: string };
}

function fakeDb(options: FakeDbOptions = {}): {
  db: RelistPrepareDeps["db"];
  relistInserts: Record<string, unknown>[];
  relistUpdates: Record<string, unknown>[];
  eventInserts: Record<string, unknown>[];
} {
  const relistInserts: Record<string, unknown>[] = [];
  const relistUpdates: Record<string, unknown>[] = [];
  const eventInserts: Record<string, unknown>[] = [];

  const credentials = {
    access_token_ciphertext: encryptToken("APP_USR-valido", ENCRYPTION_KEY),
    refresh_token_ciphertext: encryptToken("TG-valido", ENCRYPTION_KEY),
    access_token_expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
  };

  const db = {
    from: (table: string) => ({
      select: () => {
        if (table === "ml_accounts") {
          return chain({
            data: {
              id: ML_ACCOUNT_ID,
              organization_id: ORGANIZATION_ID,
              status: options.accountStatus ?? "CONNECTED",
            },
            error: null,
          });
        }

        if (table === "ml_credentials") {
          return chain({ data: credentials, error: null });
        }

        return chain({ data: null, error: null });
      },
      insert: (row: Record<string, unknown>) => {
        if (table === "listing_relists") {
          relistInserts.push(row);

          return {
            select: () => ({
              single: () =>
                Promise.resolve(
                  options.relistInsertError !== undefined
                    ? { data: null, error: options.relistInsertError }
                    : { data: { id: "op-1" }, error: null },
                ),
            }),
          };
        }

        eventInserts.push(row);

        return Promise.resolve({ error: null });
      },
      update: (patch: Record<string, unknown>) => {
        relistUpdates.push(patch);

        return {
          eq: () =>
            Promise.resolve(
              options.relistUpdateError !== undefined ? { error: options.relistUpdateError } : { error: null },
            ),
        };
      },
    }),
  } as unknown as RelistPrepareDeps["db"];

  return { db, relistInserts, relistUpdates, eventInserts };
}

function fakeClient(entries: { code: number; body: unknown }[]): {
  client: MercadoLivreClient;
  requests: RequestOptions<unknown>[];
} {
  const requests: RequestOptions<unknown>[] = [];

  const client = {
    request: (options: RequestOptions<unknown>) => {
      requests.push(options);

      return Promise.resolve(entries);
    },
  } as unknown as MercadoLivreClient;

  return { client, requests };
}

function run(db: RelistPrepareDeps["db"], client: MercadoLivreClient, payload: unknown = PAYLOAD) {
  const handler = createRelistPrepareHandler({
    db,
    mercadoLivre: client,
    oauth: { clientId: "APP_ID", clientSecret: "segredo", redirectUri: "" },
    encryptionKey: ENCRYPTION_KEY,
    now: () => NOW,
  });

  const lines: string[] = [];

  return handler(ENVELOPE, {
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    payload,
  });
}

describe("relist.prepare (D-161)", () => {
  it("payload inválido falha sem retry", async () => {
    const { db } = fakeDb();
    const { client } = fakeClient([]);

    const outcome = await run(db, client, { mlAccountId: ML_ACCOUNT_ID });

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });

  it("caminho feliz: snapshot capturado, operação REQUESTED, evento de criação com o ATOR humano", async () => {
    const { db, relistInserts, relistUpdates, eventInserts } = fakeDb();
    const { client } = fakeClient([{ code: 200, body: healthyItemBody() }]);

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(relistInserts).toHaveLength(1);
    expect(relistInserts[0]).toMatchObject({
      parent_item_id: ITEM_ID,
      status: "REQUESTED",
      requested_by: REQUESTED_BY,
    });
    expect(relistInserts[0]?.parent_snapshot).toMatchObject({ id: ITEM_ID });

    // Preflight aprovado: NENHUMA transição além da criação.
    expect(relistUpdates).toHaveLength(0);
    expect(eventInserts).toHaveLength(1);
    expect(eventInserts[0]).toMatchObject({ from_status: null, to_status: "REQUESTED", actor_user_id: REQUESTED_BY });
  });

  it("preflight reprovado: operação vai a PREFLIGHT_FAILED com os motivos, evento SEM ator (transição do sistema)", async () => {
    const { db, relistUpdates, eventInserts } = fakeDb();
    const { client } = fakeClient([{ code: 200, body: { ...healthyItemBody(), tags: ["relist"] } }]);

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(relistUpdates).toHaveLength(1);
    expect(relistUpdates[0]).toMatchObject({ status: "PREFLIGHT_FAILED" });
    expect(String(relistUpdates[0]?.failure_reason)).toContain("relist");

    expect(eventInserts).toHaveLength(2);
    expect(eventInserts[1]).toMatchObject({
      from_status: "REQUESTED",
      to_status: "PREFLIGHT_FAILED",
      actor_user_id: null,
      reason: "JA_REPUBLICADO",
    });
  });

  it("23505 no insert = operação já existe (índice de D-159): termina em paz, sem segunda operação", async () => {
    const { db, eventInserts } = fakeDb({ relistInsertError: { code: "23505", message: "duplicate" } });
    const { client } = fakeClient([{ code: 200, body: healthyItemBody() }]);

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(eventInserts).toHaveLength(0);
  });

  it("item que o ML não devolve (code != 200): done sem operação — não há snapshot para auditar", async () => {
    const { db, relistInserts } = fakeDb();
    const { client } = fakeClient([{ code: 404, body: null }]);

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(relistInserts).toHaveLength(0);
  });

  it("corpo de OUTRO item: falha sem retry — snapshot do anúncio errado é defeito, não condição transitória", async () => {
    const { db, relistInserts } = fakeDb();
    const { client } = fakeClient([{ code: 200, body: { ...healthyItemBody(), id: "MLB999999999" } }]);

    const outcome = await run(db, client);

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(relistInserts).toHaveLength(0);
  });

  it("falha ao gravar a transição de preflight reprovado: job FALHA com retry — REQUESTED aprovável seria o oposto do veredito", async () => {
    const { db } = fakeDb({ relistUpdateError: { message: "boom" } });
    const { client } = fakeClient([{ code: 200, body: { ...healthyItemBody(), tags: ["relist"] } }]);

    const outcome = await run(db, client);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("conta não CONNECTED: done sem processar — corrida benigna, não erro", async () => {
    const { db, relistInserts } = fakeDb({ accountStatus: "REVOKED" });
    const { client, requests } = fakeClient([]);

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(relistInserts).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
});
