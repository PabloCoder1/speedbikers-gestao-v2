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

function healthyChild(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CHILD,
    title: "Anúncio republicado",
    status: "active",
    price: 199.9,
    currency_id: "BRL",
    available_quantity: 5,
    category_id: "MLB1234",
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
  childItemId?: string | null;
  operationMissing?: boolean;
  updateReturnsEmpty?: boolean;
  remapError?: string;
}

interface RecordedUpdate {
  patch: Record<string, unknown>;
  fromStatus: unknown;
}

function fakeDb(options: FakeDbOptions = {}): {
  db: RelistExecuteDeps["db"];
  updates: RecordedUpdate[];
  events: Record<string, unknown>[];
  rpcCalls: Record<string, unknown>[];
} {
  const updates: RecordedUpdate[] = [];
  const events: Record<string, unknown>[] = [];
  const rpcCalls: Record<string, unknown>[] = [];

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
                  child_item_id:
                    options.childItemId === undefined
                      ? (options.operationStatus === "RELISTED" || options.operationStatus === "REMAPPED" ? CHILD : null)
                      : options.childItemId,
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
    rpc: (_name: string, args: Record<string, unknown>) => {
      rpcCalls.push(args);

      return Promise.resolve(
        options.remapError === undefined
          ? {
              data: [{ item_links_remapped: 1, variation_links_retired: 0, variation_candidates_created: 0 }],
              error: null,
            }
          : { data: null, error: { message: options.remapError } },
      );
    },
  } as unknown as RelistExecuteDeps["db"];

  return { db, updates, events, rpcCalls };
}

interface FakeClientOptions {
  parentBody?: Record<string, unknown>;
  childBody?: Record<string, unknown>;
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

      // Como o cliente REAL: toda resposta atravessa o schema do chamador —
      // é ele que aplica o transform de id de variação para string, e um
      // fake que devolvesse o corpo cru validaria de menos.
      const respond = (body: unknown) => Promise.resolve(request.schema.parse(body));

      if (request.method === "GET") {
        if (request.path === `/items/${CHILD}?include_attributes=all`) {
          return respond(options.childBody ?? healthyChild());
        }

        return respond(options.parentBody ?? healthyParent());
      }

      if (request.method === "PUT") {
        return respond({ id: PARENT, status: options.putStatus ?? "closed" });
      }

      const relist = options.relistOutcome ?? { id: CHILD };

      if (relist instanceof Error) {
        return Promise.reject(relist);
      }

      return respond(relist);
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

describe("relist.execute (D-162/D-163)", () => {
  it("caminho feliz: confirma o filho e conclui o remapeamento transacional", async () => {
    const { db, updates, events, rpcCalls } = fakeDb();
    const { client, calls } = fakeClient();

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    // O estado é persistido ANTES do ato remoto que ele descreve.
    expect(updates.map((update) => update.patch.status)).toEqual(["CLOSING", "CLOSED", "RELISTING", "RELISTED"]);
    expect(updates[3]?.patch.child_item_id).toBe(CHILD);
    expect(calls).toEqual([
      `GET /items/${PARENT}`,
      `PUT /items/${PARENT}`,
      `POST /items/${PARENT}/relist`,
      `GET /items/${CHILD}?include_attributes=all`,
    ]);
    expect(events.map((event) => event.to_status)).toEqual(["CLOSING", "CLOSED", "RELISTING", "RELISTED"]);
    expect(rpcCalls).toEqual([
      expect.objectContaining({
        p_relist_id: RELIST_ID,
        p_child_title: "Anúncio republicado",
        p_child_variations: [],
      }),
    ]);
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
    expect(calls).toEqual([
      `GET /items/${PARENT}`,
      `POST /items/${PARENT}/relist`,
      `GET /items/${CHILD}?include_attributes=all`,
    ]);
    expect(updates.map((update) => update.patch.status)).toEqual(["CLOSED", "RELISTING", "RELISTED"]);
  });

  it("retomada em RELISTED faz só GET do filho + remapeamento, sem repetir PUT/POST", async () => {
    const { db, updates, rpcCalls } = fakeDb({ operationStatus: "RELISTED" });
    const { client, calls } = fakeClient();

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates).toHaveLength(0);
    expect(calls).toEqual([`GET /items/${CHILD}?include_attributes=all`]);
    expect(rpcCalls).toHaveLength(1);
  });

  it("variações renovadas são passadas como candidatos com seller_custom_field apenas como pista", async () => {
    const { db, rpcCalls } = fakeDb({ operationStatus: "RELISTED" });
    const { client } = fakeClient({
      childBody: healthyChild({
        variations: [
          { id: 20_570_487_916, seller_custom_field: "SKU-A" },
          { id: "20570487917", seller_custom_field: null },
        ],
      }),
    });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(rpcCalls[0]?.p_child_variations).toEqual([
      { id: "20570487916", channel_sku: "SKU-A" },
      { id: "20570487917", channel_sku: null },
    ]);
  });

  it("falha da transação local é retryable: RELISTED permite retomar sem novo POST", async () => {
    const { db } = fakeDb({ operationStatus: "RELISTED", remapError: "banco indisponível" });
    const { client, calls } = fakeClient();

    const outcome = await run(db, client);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(calls).toEqual([`GET /items/${CHILD}?include_attributes=all`]);
  });

  it("REMAPPED é noop terminal — nenhuma leitura ou escrita se repete", async () => {
    const { db, updates, rpcCalls } = fakeDb({ operationStatus: "REMAPPED" });
    const { client, calls } = fakeClient();

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(updates).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
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
