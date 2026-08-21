import { randomBytes } from "node:crypto";

import { decryptToken } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { Caller } from "./auth.js";
import type { MlAccountsDeps } from "./ml-accounts.js";
import { completeConnect, startConnect } from "./ml-accounts.js";

const CALLER: Caller = {
  userId: "aaaaaaaa-0000-4000-8000-000000000001",
  organizationId: "11111111-0000-4000-8000-000000000001",
  role: "ADMIN",
};

const OAUTH_CONFIG = {
  clientId: "APP_ID_123",
  clientSecret: "SEGREDO_QUE_NAO_PODE_VAZAR",
  redirectUri: "https://api.speedbikers.example/oauth/mercado-livre/callback",
};

const ENCRYPTION_KEY = randomBytes(32);
const NOW = new Date("2026-08-21T12:00:00.000Z");

const TOKEN_RESPONSE_BODY = {
  access_token: "APP_USR-123456-090515-abcdef-1234567",
  token_type: "bearer",
  expires_in: 21_600,
  scope: "offline_access read write",
  user_id: 987654321,
  refresh_token: "TG-5b9032b4e23464aed1f959f-1234567",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Fake mínimo do cliente Supabase, no mesmo espírito de `erp-import.test.ts`:
 * só o encadeamento que `ml-accounts.ts` realmente usa. Cada método de
 * filtro devolve o próprio objeto (`this`) para o encadeamento continuar, e
 * o objeto é `thenable` para funcionar tanto com `await ...insert(...)`
 * quanto com `await ....select().maybeSingle()`.
 */
function chain<T>(result: T): {
  eq: () => ReturnType<typeof chain<T>>;
  is: () => ReturnType<typeof chain<T>>;
  gt: () => ReturnType<typeof chain<T>>;
  select: () => ReturnType<typeof chain<T>>;
  maybeSingle: () => Promise<T>;
  then: <R>(resolve: (value: T) => R) => Promise<R>;
} {
  const self = {
    eq: () => self,
    is: () => self,
    gt: () => self,
    select: () => self,
    maybeSingle: () => Promise.resolve(result),
    then: <R>(resolve: (value: T) => R) => Promise.resolve(result).then(resolve),
  };

  return self;
}

interface FakeDbOptions {
  accountLookup?: { data: { id: string; status: string } | null; error: { message: string } | null };
  stateInsertFails?: boolean;
  claimedState?: { data: { organization_id: string; ml_account_id: string } | null; error: { message: string } | null };
  credentialsUpsertFails?: boolean;
  accountUpdateFails?: boolean;
  slug?: string;
}

function fakeDb(options: FakeDbOptions = {}): {
  db: MlAccountsDeps["db"];
  inserted: { table: string; row: unknown }[];
  updated: { table: string; row: unknown }[];
  upserted: { table: string; row: unknown }[];
} {
  const inserted: { table: string; row: unknown }[] = [];
  const updated: { table: string; row: unknown }[] = [];
  const upserted: { table: string; row: unknown }[] = [];

  const db = {
    from: (table: string) => ({
      select: () =>
        chain(
          options.accountLookup ?? { data: { id: "acc-1", status: "PENDING" }, error: null },
        ),
      insert: (row: unknown) => {
        inserted.push({ table, row });

        return chain(
          options.stateInsertFails === true
            ? { data: null, error: { message: "boom" } }
            : { data: null, error: null },
        );
      },
      update: (row: unknown) => {
        updated.push({ table, row });

        if (table === "ml_oauth_states") {
          return chain(
            options.claimedState ??
              { data: { organization_id: CALLER.organizationId, ml_account_id: "acc-1" }, error: null },
          );
        }

        return chain(
          options.accountUpdateFails === true
            ? { data: null, error: { message: "boom" } }
            : { data: { slug: options.slug ?? "loja-1" }, error: null },
        );
      },
      upsert: (row: unknown) => {
        upserted.push({ table, row });

        return chain(
          options.credentialsUpsertFails === true
            ? { data: null, error: { message: "boom" } }
            : { data: null, error: null },
        );
      },
    }),
  } as unknown as MlAccountsDeps["db"];

  return { db, inserted, updated, upserted };
}

function deps(
  overrides: Partial<MlAccountsDeps> & { dbOptions?: FakeDbOptions; enqueueFails?: boolean } = {},
): {
  deps: MlAccountsDeps;
  lines: string[];
  db: ReturnType<typeof fakeDb>;
  enqueued: { jobType: string; dedupeKey: string; queue: string; organizationId: string; payload?: Record<string, unknown> }[];
} {
  const lines: string[] = [];
  const db = fakeDb(overrides.dbOptions);
  const enqueued: {
    jobType: string;
    dedupeKey: string;
    queue: string;
    organizationId: string;
    payload?: Record<string, unknown>;
  }[] = [];

  return {
    lines,
    db,
    enqueued,
    deps: {
      db: db.db,
      oauth: OAUTH_CONFIG,
      encryptionKey: ENCRYPTION_KEY,
      logger: createLogger({}, { sink: (line) => lines.push(line) }),
      now: () => NOW,
      requestOptions: { fetchImpl: () => Promise.resolve(jsonResponse(200, TOKEN_RESPONSE_BODY)), sleep: () => Promise.resolve() },
      enqueuer: {
        enqueue: (request) => {
          if (overrides.enqueueFails === true) {
            return Promise.reject(new Error("Cloud Tasks fora do ar"));
          }

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
      ...overrides,
    },
  };
}

describe("startConnect", () => {
  it("devolve not_found quando a conta não existe na organização do chamador", async () => {
    const { deps: d } = deps({ dbOptions: { accountLookup: { data: null, error: null } } });

    const outcome = await startConnect(d, CALLER, "acc-inexistente");

    expect(outcome.status).toBe("not_found");
  });

  it("recusa reconectar uma conta já CONNECTED", async () => {
    const { deps: d } = deps({ dbOptions: { accountLookup: { data: { id: "acc-1", status: "CONNECTED" }, error: null } } });

    const outcome = await startConnect(d, CALLER, "acc-1");

    expect(outcome).toEqual({ status: "rejected", reason: "conta já conectada" });
  });

  it("permite reconectar uma conta PENDING, REVOKED ou ERROR", async () => {
    for (const status of ["PENDING", "REVOKED", "ERROR"]) {
      const { deps: d } = deps({ dbOptions: { accountLookup: { data: { id: "acc-1", status }, error: null } } });

      const outcome = await startConnect(d, CALLER, "acc-1");

      expect(outcome.status).toBe("redirect");
    }
  });

  it("grava o state e devolve a URL de autorização com ele", async () => {
    const { deps: d, db } = deps();

    const outcome = await startConnect(d, CALLER, "acc-1");

    expect(outcome.status).toBe("redirect");
    if (outcome.status !== "redirect") return;

    const url = new URL(outcome.authorizationUrl);
    const state = url.searchParams.get("state");

    expect(state).not.toBeNull();
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]).toMatchObject({
      table: "ml_oauth_states",
      row: {
        state,
        organization_id: CALLER.organizationId,
        ml_account_id: "acc-1",
        created_by: CALLER.userId,
      },
    });
  });

  it("devolve rejected quando a gravação do state falha", async () => {
    const { deps: d } = deps({ dbOptions: { stateInsertFails: true } });

    const outcome = await startConnect(d, CALLER, "acc-1");

    expect(outcome).toEqual({ status: "rejected", reason: "não foi possível iniciar a autorização" });
  });
});

describe("completeConnect", () => {
  it("devolve invalid_state quando o state não existe, expirou ou já foi consumido", async () => {
    const { deps: d } = deps({ dbOptions: { claimedState: { data: null, error: null } } });

    const outcome = await completeConnect(d, { state: "desconhecido", code: "abc" });

    expect(outcome).toEqual({ status: "invalid_state" });
  });

  it("marca a conta em ERROR e rejeita quando o Mercado Livre nega a autorização", async () => {
    const { deps: d, db } = deps();

    const outcome = await completeConnect(d, { state: "s", error: "access_denied" });

    expect(outcome).toEqual({ status: "rejected", reason: "autorização negada no Mercado Livre" });
    const accountsUpdate = db.updated.find((entry) => entry.table === "ml_accounts");
    expect(accountsUpdate?.row).toMatchObject({ status: "ERROR" });
  });

  it("rejeita quando não há error nem code — callback malformado", async () => {
    const { deps: d } = deps();

    const outcome = await completeConnect(d, { state: "s" });

    expect(outcome.status).toBe("rejected");
  });

  it("marca a conta em ERROR e rejeita quando a troca de token falha", async () => {
    const { deps: d, db } = deps({
      requestOptions: { fetchImpl: () => Promise.resolve(jsonResponse(400, { error: "invalid_grant" })), sleep: () => Promise.resolve() },
    });

    const outcome = await completeConnect(d, { state: "s", code: "code-invalido" });

    expect(outcome.status).toBe("rejected");
    const accountsUpdate = db.updated.find((entry) => entry.table === "ml_accounts");
    expect(accountsUpdate?.row).toMatchObject({ status: "ERROR" });
  });

  it("cifra os tokens, nunca grava texto claro, e marca a conta CONNECTED", async () => {
    const { deps: d, db } = deps();

    const outcome = await completeConnect(d, { state: "s", code: "code-valido" });

    expect(outcome).toEqual({ status: "connected", mlAccountId: "acc-1" });

    const credentials = db.upserted.find((entry) => entry.table === "ml_credentials");
    expect(credentials).toBeDefined();
    const row = credentials?.row as {
      access_token_ciphertext: string;
      refresh_token_ciphertext: string;
      scopes: string[];
    };

    expect(row.access_token_ciphertext).not.toContain(TOKEN_RESPONSE_BODY.access_token);
    expect(row.refresh_token_ciphertext).not.toContain(TOKEN_RESPONSE_BODY.refresh_token);
    expect(decryptToken(row.access_token_ciphertext, ENCRYPTION_KEY)).toBe(TOKEN_RESPONSE_BODY.access_token);
    expect(decryptToken(row.refresh_token_ciphertext, ENCRYPTION_KEY)).toBe(TOKEN_RESPONSE_BODY.refresh_token);
    expect(row.scopes).toEqual(["offline_access", "read", "write"]);

    const accountsUpdate = db.updated.find((entry) => entry.table === "ml_accounts");
    expect(accountsUpdate?.row).toMatchObject({
      status: "CONNECTED",
      seller_id: TOKEN_RESPONSE_BODY.user_id,
      connected_at: NOW.toISOString(),
      last_error: null,
    });
  });

  it("dispara o backfill de história ao conectar — sem ele, pedidos anteriores à conexão nunca apareceriam", async () => {
    const { deps: d, enqueued } = deps({ dbOptions: { slug: "sbmotos" } });

    const outcome = await completeConnect(d, { state: "s", code: "code-valido" });

    expect(outcome.status).toBe("connected");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      jobType: "backfill.orders",
      organizationId: CALLER.organizationId,
      queue: "backfill",
      dedupeKey: "backfill-orders:sbmotos:start",
      payload: { mlAccountId: "acc-1" },
    });
  });

  it("falha ao enfileirar o backfill não desfaz a conexão já gravada", async () => {
    const { deps: d, lines } = deps({ enqueueFails: true });

    const outcome = await completeConnect(d, { state: "s", code: "code-valido" });

    expect(outcome).toEqual({ status: "connected", mlAccountId: "acc-1" });
    expect(lines.join()).toContain("backfill_not_triggered");
  });

  it("devolve rejected quando a gravação das credenciais falha", async () => {
    const { deps: d } = deps({ dbOptions: { credentialsUpsertFails: true } });

    const outcome = await completeConnect(d, { state: "s", code: "code-valido" });

    expect(outcome).toEqual({ status: "rejected", reason: "não foi possível gravar as credenciais" });
  });

  it("devolve rejected quando a conta não pôde ser marcada CONNECTED após gravar as credenciais", async () => {
    const { deps: d } = deps({ dbOptions: { accountUpdateFails: true } });

    const outcome = await completeConnect(d, { state: "s", code: "code-valido" });

    expect(outcome.status).toBe("rejected");
  });

  it("nunca loga access_token, refresh_token nem client_secret", async () => {
    const { deps: d, lines } = deps();

    await completeConnect(d, { state: "s", code: "code-valido" });

    const joined = lines.join("\n");
    expect(joined).not.toContain(TOKEN_RESPONSE_BODY.access_token);
    expect(joined).not.toContain(TOKEN_RESPONSE_BODY.refresh_token);
    expect(joined).not.toContain(OAUTH_CONFIG.clientSecret);
  });
});
