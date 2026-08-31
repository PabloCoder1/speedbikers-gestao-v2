import { randomBytes } from "node:crypto";

import { MercadoLivreApiError, encryptToken } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { RelistExecuteDeps } from "./relist-execute.js";
import { createRelistExecuteHandler } from "./relist-execute.js";

const RELIST_ID = "cccccccc-0000-4000-8000-000000000001";
const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const PARENT = "MLB910000001";
const CHILD = "MLB910000777";
const ENCRYPTION_KEY = randomBytes(32);
const NOW = new Date("2026-08-31T13:00:00.000Z");

const ENVELOPE = {
  jobType: "relist.execute",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b44",
  organizationId: ORGANIZATION_ID,
  dedupeKey: `relist-execute:${RELIST_ID}:2026-08-31T13:00`,
  attempt: 1,
  enqueuedAt: NOW.toISOString(),
};

function healthyParent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PARENT,
    status: "active",
    price: 199.9,
    available_quantity: 5,
    listing_type_id: "gold_special",
    tags: [],
    catalog_listing: false,
    variations: [],
    ...overrides,
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
  operationStatus?: string;
  operationMissing?: boolean;
  updateReturnsEmpty?: boolean;
}

interface RecordedUpdate {
  patch: Record<string, unknown>;
  fromStatus: unknown;
}

function fakeDb(options: FakeDbOptions = {}): {
  db: RelistExecuteDeps["db"];
  updates: RecordedUpdate[];
  events: Record<string, unknown>[];
} {
  const updates: RecordedUpdate[] = [];
  const events: Record<string, unknown>[] = [];

  const credentials = {
    access_token_ciphertext: encryptToken("APP_USR-valido", ENCRYPTION_KEY),
    refresh_token_ciphertext: encryptToken("TG-valido", ENCRYPTION_KEY),
    access_token_expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
  };

  const db = {
    from: (table: string) => ({
      select: () => {
        if (table === "listing_relists") {
          return chain({
            data: options.operationMissing === true
              ? null
              : {
                  id: RELIST_ID,
                  organization_id: ORGANIZATION_ID,
                  ml_account_id: ML_ACCOUNT_ID,
                  parent_item_id: PARENT,
                  status: options.operationStatus ?? "REQUESTED",
                },
            error: null,
          });
        }

        if (table === "ml_credentials") {
          return chain({ data: credentials, error: null });
        }

        return chain({ data: null, error: null });
      },
      update: (patch: Record<string, unknown>) => ({
        eq: () => ({
          eq: (_column: string, fromStatus: unknown) => ({
            select: () => {
              updates.push({ patch, fromStatus });

              return Promise.resolve(
                options.updateReturnsEmpty === true
                  ? { data: [], error: null }
                  : { data: [{ id: RELIST_ID }], error: null },
              );
            },
          }),
        }),
      }),
      insert: (row: Record<string, unknown>) => {
        events.push(row);

        return Promise.resolve({ error: null });
      },
    }),
  } as unknown as RelistExecuteDeps["db"];

  return { db, updates, events };
}

interface FakeClientOptions {
  parentBody?: Record<string, unknown>;
  putStatus?: string;
  relistOutcome?: { id: string } | Error;
}

function fakeClient(options: FakeClientOptions = {}): {
  client: MercadoLivreClient;
  calls: string[];
} {
  const calls: string[] = [];

  const client = {
    request: (request: RequestOptions<unknown>) => {
      calls.push(`${request.method} ${request.path}`);

      if (request.method === "GET") {
        return Promise.resolve(options.parentBody ?? healthyParent());
      }

      if (request.method === "PUT") {
        return Promise.resolve({ id: PARENT, status: options.putStatus ?? "closed" });
      }

      const relist = options.relistOutcome ?? { id: CHILD };

      if (relist instanceof Error) {
        return Promise.reject(relist);
      }

      return Promise.resolve(relist);
    },
  } as unknown as MercadoLivreClient;

  return { client, calls };
}

function run(db: RelistExecuteDeps["db"], client: MercadoLivreClient) {
  const handler = createRelistExecuteHandler({
    db,
    mercadoLivre: client,
    oauth: { clientId: "APP_ID", clientSecret: "segredo", redirectUri: "" },
    encryptionKey: ENCRYPTION_KEY,
    now: () => NOW,
  });

  const lines: string[] = [];

  return handler(ENVELOPE, {
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    payload: { relistId: RELIST_ID },
  });
}

describe("relist.execute (D-162)", () => {
  it("caminho feliz: re-preflight → CLOSING → PUT → CLOSED → RELISTING → POST → RELISTED com o filho", async () => {
    const { db, updates, events } = fakeDb();
    const { client, calls } = fakeClient();

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    // O estado é persistido ANTES do ato remoto que ele descreve.
    expect(updates.map((update) => update.patch.status)).toEqual(["CLOSING", "CLOSED", "RELISTING", "RELISTED"]);
    expect(updates[3]?.patch.child_item_id).toBe(CHILD);
    expect(calls).toEqual([`GET /items/${PARENT}`, `PUT /items/${PARENT}`, `POST /items/${PARENT}/relist`]);
    expect(events.map((event) => event.to_status)).toEqual(["CLOSING", "CLOSED", "RELISTING", "RELISTED"]);
    // Transições do sistema: SEM ator.
    expect(events.every((event) => event.actor_user_id === null)).toBe(true);
  });

  it("re-preflight reprova NA HORA (o pai entrou no Full desde o pedido): PREFLIGHT_FAILED, e o PUT nunca sai", async () => {
    const { db, updates } = fakeDb();
    const { client, calls } = fakeClient({ parentBody: healthyParent({ inventory_id: "LCQI05831" }) });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => update.patch.status)).toEqual(["PREFLIGHT_FAILED"]);
    expect(calls).toEqual([`GET /items/${PARENT}`]);
  });

  it("retomada em RELISTING vira RELIST_FAILED sem NENHUMA chamada remota — repetir o POST poderia criar dois filhos", async () => {
    const { db, updates } = fakeDb({ operationStatus: "RELISTING" });
    const { client, calls } = fakeClient();

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => update.patch.status)).toEqual(["RELIST_FAILED"]);
    expect(calls).toEqual([]);
  });

  it("POST /relist falha: RELIST_FAILED, nunca retry — um 5xx pode significar que o filho nasceu", async () => {
    const { db, updates } = fakeDb();
    const { client } = fakeClient({
      relistOutcome: new MercadoLivreApiError("500", { status: 500, errorClass: "retryable", url: "x" }),
    });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => update.patch.status)).toEqual([
      "CLOSING",
      "CLOSED",
      "RELISTING",
      "RELIST_FAILED",
    ]);
  });

  it("resposta ambígua (id do próprio pai — o defeito documentado da doc): RELIST_FAILED, filho não confirmado", async () => {
    const { db, updates } = fakeDb();
    const { client } = fakeClient({ relistOutcome: { id: PARENT } });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.at(-1)?.patch.status).toBe("RELIST_FAILED");
    expect(String(updates.at(-1)?.patch.failure_reason)).toContain("próprio id do pai");
  });

  it("PUT responde sem fechar: CLOSE_FAILED (reabrível, nada destrutivo aconteceu) e o POST nunca sai", async () => {
    const { db, updates } = fakeDb();
    const { client, calls } = fakeClient({ putStatus: "active" });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => update.patch.status)).toEqual(["CLOSING", "CLOSE_FAILED"]);
    expect(calls).not.toContain(`POST /items/${PARENT}/relist`);
  });

  it("retomada em CLOSING com o pai JÁ fechado no remoto: segue sem repetir o PUT", async () => {
    const { db, updates } = fakeDb({ operationStatus: "CLOSING" });
    const { client, calls } = fakeClient({ parentBody: healthyParent({ status: "closed" }) });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(calls).toEqual([`GET /items/${PARENT}`, `POST /items/${PARENT}/relist`]);
    expect(updates.map((update) => update.patch.status)).toEqual(["CLOSED", "RELISTING", "RELISTED"]);
  });

  it("estado que este job não trata (RELISTED) é noop — trabalho já feito não se refaz", async () => {
    const { db, updates } = fakeDb({ operationStatus: "RELISTED" });
    const { client, calls } = fakeClient();

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(updates).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("CAS perdido (0 linhas na transição): o job FALHA com retry e relê o estado — nunca grava evento de transição que não aconteceu", async () => {
    const { db, events } = fakeDb({ updateReturnsEmpty: true });
    const { client } = fakeClient();

    const outcome = await run(db, client);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(events).toHaveLength(0);
  });
});
