import { randomBytes } from "node:crypto";

import { isRelistRetryEligible, isRelistUserProductVariationsRejection, relistRejectionFailureReason } from "@sb/domain";
import { MercadoLivreApiError, createMercadoLivreClient, encryptToken } from "@sb/mercado-livre";
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
const REQUESTED_BY = "bbbbbbbb-0000-4000-8000-000000000002";
/** Quem autorizou a retomada (D-364) — outra pessoa, de propósito. */
const AUTORIZADO_POR = "bbbbbbbb-0000-4000-8000-000000000003";
const OPERATION_UPDATED_AT = "2026-08-31T12:59:00.123456+00:00";
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
    is: () => self,
    select: () => self,
    order: () => self,
    limit: () => self,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };

  return self;
}

/** Uma linha de `listing_relist_events` como a consulta da retomada a lê. */
interface EventRow {
  relist_id: string;
  to_status: string;
  reason: string | null;
  occurred_at: string;
}

/**
 * A leitura de eventos APLICA filtros, ordem e limite sobre um histórico de
 * verdade (achado R2 da revisão de D-364): um fake que devolvesse um motivo
 * fixo aprovaria a consulta com a ordem invertida ou sem filtro.
 */
function historyQuery(rows: readonly EventRow[]): unknown {
  let result = [...rows];
  const self = {
    select: () => self,
    eq: (column: keyof EventRow, value: string) => {
      result = result.filter((row) => row[column] === value);

      return self;
    },
    order: (column: keyof EventRow, options: { ascending: boolean }) => {
      result.sort((a, b) => String(a[column]).localeCompare(String(b[column])));

      if (!options.ascending) {
        result.reverse();
      }

      return self;
    },
    limit: (count: number) => {
      result = result.slice(0, count);

      return self;
    },
    maybeSingle: () => Promise.resolve({ data: result[0] === undefined ? null : { reason: result[0].reason }, error: null }),
  };

  return self;
}

function falhaRegistrada(reason: string | null, occurredAt = "2026-08-31T12:59:00.123456+00:00", overrides: Partial<EventRow> = {}): EventRow {
  return { relist_id: RELIST_ID, to_status: "RELIST_FAILED", reason, occurred_at: occurredAt, ...overrides };
}

interface FakeDbOptions {
  operationStatus?: string;
  childItemId?: string | null;
  operationMissing?: boolean;
  updateReturnsEmpty?: boolean;
  remapError?: string;
  failureReason?: string | null;
  /** reason do último evento RELIST_FAILED; ausente = nenhum evento. */
  lastFailedReason?: string | null;
  /** O histórico inteiro, no lugar de `lastFailedReason`. */
  eventHistory?: EventRow[];
}

interface RecordedUpdate {
  patch: Record<string, unknown>;
  fromStatus: unknown;
  /** Todos os `.eq` do update — o CAS. */
  filters: Record<string, unknown>;
}

function fakeDb(options: FakeDbOptions = {}): {
  db: RelistExecuteDeps["db"];
  updates: RecordedUpdate[];
  events: Record<string, unknown>[];
  rpcCalls: Record<string, unknown>[];
  decisionInserts: Record<string, unknown>[];
} {
  const updates: RecordedUpdate[] = [];
  const events: Record<string, unknown>[] = [];
  const rpcCalls: Record<string, unknown>[] = [];
  const decisionInserts: Record<string, unknown>[] = [];

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
                  failure_reason: options.failureReason ?? null,
                  requested_by: REQUESTED_BY,
                  updated_at: OPERATION_UPDATED_AT,
                },
            error: null,
          });
        }

        // Retomada (D-364): o último evento RELIST_FAILED da operação.
        if (table === "listing_relist_events") {
          return historyQuery(
            options.eventHistory ?? (options.lastFailedReason === undefined ? [] : [falhaRegistrada(options.lastFailedReason)]),
          );
        }

        if (table === "ml_credentials") {
          return chain({ data: credentials, error: null });
        }

        // Medição (D-164): vínculo do filho com SKU; ação/decisão inexistentes.
        if (table === "sku_listing_links") {
          const self = {
            eq: () => self,
            is: () => self,
            maybeSingle: () => Promise.resolve({ data: { sku_id: "dddddddd-0000-4000-8000-000000000003" }, error: null }),
          };

          return self;
        }

        return chain({ data: null, error: null });
      },
      update: (patch: Record<string, unknown>) => {
        const filters: Record<string, unknown> = {};
        const builder = {
          eq: (column: string, value: unknown) => {
            filters[column] = value;

            return builder;
          },
          select: () => {
            updates.push({ patch, fromStatus: filters.status, filters });

            return Promise.resolve(
              options.updateReturnsEmpty === true ? { data: [], error: null } : { data: [{ id: RELIST_ID }], error: null },
            );
          },
        };

        return builder;
      },
      insert: (row: Record<string, unknown>) => {
        if (table === "actions") {
          return {
            select: () => ({ single: () => Promise.resolve({ data: { id: "action-1" }, error: null }) }),
          };
        }

        if (table === "action_decisions") {
          decisionInserts.push(row);

          return Promise.resolve({ error: null });
        }

        events.push(row);

        return Promise.resolve({ error: null });
      },
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      // O snapshot da medição (D-164) não entra em rpcCalls — as
      // afirmações sobre o REMAPEAMENTO continuam contando só o remap.
      if (name === "get_sku_decision_snapshot") {
        return Promise.resolve({ data: { as_of: "2026-08-31" }, error: null });
      }

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

  return { db, updates, events, rpcCalls, decisionInserts };
}

interface FakeClientOptions {
  parentBody?: Record<string, unknown>;
  childBody?: Record<string, unknown>;
  putStatus?: string;
  relistOutcome?: { id: string } | Error;
  /** Estoque do Full por inventory_id: corpo da resposta ou erro lançado (D-360). Ausente = 404. */
  fullStock?: Record<string, Record<string, unknown> | Error>;
  /** Tags da conta em GET /users/me (D-369): a lista, ou o erro lançado. Ausente = conta SEM `user_product_seller`. */
  sellerTags?: string[] | Error;
}

/** As tags de uma conta que NÃO está no modelo de user products. */
const TAGS_SEM_UP = ["normal", "eshop"];

/** As tags medidas nas quatro contas em 17/09/2026 (D-369). */
const TAGS_COM_UP = ["normal", "user_product_seller", "eshop"];

function fakeClient(options: FakeClientOptions = {}): {
  client: MercadoLivreClient;
  calls: string[];
  bodies: Record<string, unknown>;
} {
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {};

  const client = {
    request: (request: RequestOptions<unknown>) => {
      calls.push(`${request.method} ${request.path}`);

      if (request.body !== undefined) {
        bodies[`${request.method} ${request.path}`] = request.body;
      }

      // Como o cliente REAL: toda resposta atravessa o schema do chamador —
      // é ele que aplica o transform de id de variação para string, e um
      // fake que devolvesse o corpo cru validaria de menos.
      const respond = (body: unknown) => Promise.resolve(request.schema.parse(body));

      const inventory = /^\/inventories\/([^/]+)\/stock\/fulfillment$/.exec(request.path);

      if (request.method === "GET" && inventory !== null) {
        const answer = options.fullStock?.[inventory[1] ?? ""];

        if (answer === undefined) {
          return Promise.reject(
            new MercadoLivreApiError("inventário não encontrado", { status: 404, errorClass: "not_retryable", url: request.path }),
          );
        }

        return answer instanceof Error ? Promise.reject(answer) : respond(answer);
      }

      // D-369: o modelo da conta. Tratado ANTES do GET genérico — senão o
      // corpo do pai atravessaria o schema de /users/me.
      if (request.method === "GET" && request.path === "/users/me") {
        const tags = options.sellerTags ?? TAGS_SEM_UP;

        return tags instanceof Error ? Promise.reject(tags) : respond({ id: 244_878_077, tags });
      }

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

  return { client, calls, bodies };
}

function run(
  db: RelistExecuteDeps["db"],
  client: MercadoLivreClient,
  payload: Record<string, unknown> = { relistId: RELIST_ID },
  lines: string[] = [],
) {
  const handler = createRelistExecuteHandler({
    db,
    mercadoLivre: client,
    oauth: { clientId: "APP_ID", clientSecret: "segredo", redirectUri: "" },
    encryptionKey: ENCRYPTION_KEY,
    now: () => NOW,
  });

  return handler(ENVELOPE, {
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    payload,
  });
}

describe("relist.execute (D-162/D-163)", () => {
  it("caminho feliz: confirma o filho e conclui o remapeamento transacional (item sem variações não lê a conta, D-369)", async () => {
    const { db, updates, events, rpcCalls, decisionInserts } = fakeDb();
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
    // Medição 7/15/30 (D-164): a decisão de D-065 nasce junto do REMAPPED,
    // atribuída ao humano que pediu a republicação.
    expect(decisionInserts).toHaveLength(1);
    expect(decisionInserts[0]).toMatchObject({ created_by: REQUESTED_BY });
  });

  it("re-preflight reprova NA HORA (o pai entrou no Full desde o pedido): PREFLIGHT_FAILED, e o PUT nunca sai", async () => {
    const { db, updates } = fakeDb();
    const { client, calls } = fakeClient({
      parentBody: healthyParent({ inventory_id: "LCQI05831" }),
      fullStock: { LCQI05831: { inventory_id: "LCQI05831", available_quantity: 4, not_available_quantity: 0 } },
    });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => update.patch.status)).toEqual(["PREFLIGHT_FAILED"]);
    expect(updates[0]?.patch.failure_reason).toContain("4 unidade(s)");
    expect(calls).toEqual([`GET /items/${PARENT}`, "GET /inventories/LCQI05831/stock/fulfillment"]);
  });

  it("D-360: cadastro no Full ZERADO e envio por coleta — o re-preflight aprova e o pai é fechado", async () => {
    const { db, updates } = fakeDb();
    const { client, calls } = fakeClient({
      parentBody: healthyParent({ inventory_id: "TBWT07652", shipping: { logistic_type: "cross_docking" } }),
      fullStock: { TBWT07652: { inventory_id: "TBWT07652", available_quantity: 0, not_available_quantity: 0 } },
    });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => update.patch.status)).toEqual(["CLOSING", "CLOSED", "RELISTING", "RELISTED"]);
    expect(calls.slice(0, 3)).toEqual([
      `GET /items/${PARENT}`,
      "GET /inventories/TBWT07652/stock/fulfillment",
      `PUT /items/${PARENT}`,
    ]);
  });

  it("D-360: estoque do Full ilegível (404) reprova com FULL_NAO_VERIFICADO — o PUT nunca sai", async () => {
    const { db, updates, events } = fakeDb();
    const { client, calls } = fakeClient({ parentBody: healthyParent({ inventory_id: "TBWT07652" }) });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => update.patch.status)).toEqual(["PREFLIGHT_FAILED"]);
    expect(events.map((event) => event.reason)).toEqual(["FULL_NAO_VERIFICADO"]);
    expect(calls.some((call) => call.startsWith("PUT"))).toBe(false);
  });

  it("D-360: falha passageira ao ler o Full relança ANTES de qualquer transição — o PUT nunca sai", async () => {
    const { db, updates } = fakeDb();
    const { client, calls } = fakeClient({
      parentBody: healthyParent({ inventory_id: "TBWT07652" }),
      fullStock: {
        TBWT07652: new MercadoLivreApiError("serviço indisponível", { status: 503, errorClass: "retryable", url: "/inventories" }),
      },
    });

    await expect(run(db, client)).rejects.toThrow("serviço indisponível");
    expect(updates).toHaveLength(0);
    expect(calls.some((call) => call.startsWith("PUT"))).toBe(false);
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

  it("D-369 (A1): retomada em CLOSING com o pai ATIVO e variações de user products: CLOSE_FAILED, nenhum PUT, nenhum POST", async () => {
    const { db, updates, events } = fakeDb({ operationStatus: "CLOSING" });
    const { client, calls } = fakeClient({ parentBody: parentWithUserProductVariations({ status: "active" }) });
    const lines: string[] = [];

    const outcome = await run(db, client, { relistId: RELIST_ID }, lines);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(calls).toEqual([`GET /items/${PARENT}`]);
    expect(updates.map((update) => [update.fromStatus, update.patch.status])).toEqual([["CLOSING", "CLOSE_FAILED"]]);
    expect(updates[0]?.patch.failure_reason).toBe(
      "O Mercado Livre não permite republicar anúncio com variações de conta no modelo de user products — fechar o anúncio o deixaria fora do ar sem filho.",
    );
    expect(events.map((event) => [event.to_status, event.reason])).toEqual([["CLOSE_FAILED", "VARIACOES_USER_PRODUCT"]]);
    expect(logs(lines).find((line) => line.message === "relist_closing_user_product_variations")).toMatchObject({
      block: "VARIACOES_USER_PRODUCT",
    });
  });

  it("D-369 (A1): retomada em CLOSING com o pai ativo e variações sem user_product_id — a conta decide: com a tag ou sem leitura para, sem a tag fecha", async () => {
    for (const [sellerTags, reason] of [
      [TAGS_COM_UP, "VARIACOES_USER_PRODUCT"],
      [new MercadoLivreApiError("Mercado Livre respondeu 500 para GET /users/me.", { status: 500, errorClass: "retryable", url: "x" }), "USER_PRODUCT_NAO_VERIFICADO"],
    ] as const) {
      const { db, updates, events } = fakeDb({ operationStatus: "CLOSING" });
      const { client, calls } = fakeClient({ parentBody: parentWithVariations({ status: "active" }), sellerTags });

      const outcome = await run(db, client);

      expect(outcome).toEqual({ status: "done", processed: 1 });
      expect(calls).toEqual([`GET /items/${PARENT}`, "GET /users/me"]);
      expect(updates.map((update) => update.patch.status)).toEqual(["CLOSE_FAILED"]);
      expect(events.map((event) => event.reason)).toEqual([reason]);
    }

    const { db, updates } = fakeDb({ operationStatus: "CLOSING" });
    const { client, calls } = fakeClient({ parentBody: parentWithVariations({ status: "active" }), sellerTags: TAGS_SEM_UP });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(calls.slice(0, 4)).toEqual([
      `GET /items/${PARENT}`,
      "GET /users/me",
      `PUT /items/${PARENT}`,
      `POST /items/${PARENT}/relist`,
    ]);
    expect(updates.map((update) => update.patch.status)).toEqual(["CLOSED", "RELISTING", "RELISTED"]);
  });

  it("D-369 (A1): retomada em CLOSING com o pai ativo SEM variações fecha como antes, sem ler a conta", async () => {
    const { db, updates } = fakeDb({ operationStatus: "CLOSING" });
    const { client, calls } = fakeClient({ sellerTags: TAGS_COM_UP });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(calls.slice(0, 3)).toEqual([`GET /items/${PARENT}`, `PUT /items/${PARENT}`, `POST /items/${PARENT}/relist`]);
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

  it("REMAPPED retomado garante a MEDIÇÃO (D-164) sem nenhuma chamada remota — e nada mais se repete", async () => {
    const { db, updates, rpcCalls, decisionInserts } = fakeDb({ operationStatus: "REMAPPED" });
    const { client, calls } = fakeClient();

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(updates).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
    expect(calls).toEqual([]);
    // A garantia idempotente: a decisão de D-065 existe ao sair daqui.
    expect(decisionInserts).toHaveLength(1);
    expect(decisionInserts[0]).toMatchObject({ created_by: REQUESTED_BY });
  });

  it("CAS perdido (0 linhas na transição): o job FALHA com retry e relê o estado — nunca grava evento de transição que não aconteceu", async () => {
    const { db, events } = fakeDb({ updateReturnsEmpty: true });
    const { client } = fakeClient();

    const outcome = await run(db, client);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(events).toHaveLength(0);
  });
});

/** O pai com variações do incidente (MLB1476804187), reduzido a três: uma zerada. */
function parentWithVariations(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return healthyParent({
    price: 114.9,
    available_quantity: 1_235,
    shipping: { logistic_type: "cross_docking" },
    variations: [
      { id: 180_214_523_001, price: 114.9, available_quantity: 1_200 },
      { id: "180214523002", price: 129.9, available_quantity: 35 },
      { id: 180_214_523_003, price: 114.9, available_quantity: 0 },
    ],
    ...overrides,
  });
}

const CORPO_COM_VARIACOES = {
  listing_type_id: "gold_special",
  variations: [
    { id: 180_214_523_001, price: 114.9, quantity: 1_200 },
    { id: 180_214_523_002, price: 129.9, quantity: 35 },
  ],
};

/** O corpo de erro do ML na forma documentada (message, error, status, cause[]). */
function recusa400(body: unknown = {
  message: "Validation error",
  error: "validation_error",
  status: 400,
  cause: [{ code: "item.variations.missing", message: "Item with variations must be relisted with variations" }],
}): MercadoLivreApiError {
  return new MercadoLivreApiError(`Mercado Livre respondeu 400 para POST /items/${PARENT}/relist.`, {
    status: 400,
    errorClass: "not_retryable",
    url: `https://api.mercadolibre.com/items/${PARENT}/relist`,
    body,
  });
}

function logs(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const RETOMADA = { relistId: RELIST_ID, retomada: true, autorizadoPor: AUTORIZADO_POR };

/** O pai do incidente como o GET /items o devolve: `user_product_id` em cada variação, nulo na raiz (D-369). */
function parentWithUserProductVariations(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return parentWithVariations({
    user_product_id: null,
    variations: [
      { id: 52_844_432_013, price: 114.9, available_quantity: 698, user_product_id: "MLBU1406603522" },
      { id: 52_844_432_017, price: 114.9, available_quantity: 9_981, user_product_id: "MLBU1402620069" },
    ],
    ...overrides,
  });
}

/** O `failure_reason` REAL da a7638dc5 depois da retomada de 2026-09-17 13:36 UTC (D-369). */
const RECUSA_USER_PRODUCT = relistRejectionFailureReason(
  400,
  "Validation error (validation_error) causas: item.variations.relist.invalid: Relist item with variations are not allowed for user product seller",
);

/** O `failure_reason` que a recusa grava (D-364) — a linha e o evento `POST_RECUSADO` concordam. */
const RECUSA_GRAVADA = relistRejectionFailureReason(400, "Validation error causas: item.variations.missing");

/** A mensagem que o executor gravava antes de D-364 para o 400 (a operação a7638dc5, com o MLB deste teste). */
const MENSAGEM_LEGADA_400 = `o POST /relist falhou e não é seguro repetir: Mercado Livre respondeu 400 para POST /items/${PARENT}/relist.`;

describe("relist.execute com variações e recusa do ML (D-364)", () => {
  it("o POST do pai COM variações leva listing_type_id + variations com preço próprio, sem a zerada e sem price/quantity na raiz", async () => {
    const { db, updates } = fakeDb();
    const { client, bodies, calls } = fakeClient({ parentBody: parentWithVariations() });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => update.patch.status)).toEqual(["CLOSING", "CLOSED", "RELISTING", "RELISTED"]);
    expect(bodies[`POST /items/${PARENT}/relist`]).toEqual(CORPO_COM_VARIACOES);
    // D-369 (A3): a conta foi lida SEM a tag antes do PUT — é isso que permite.
    expect(calls.slice(0, 3)).toEqual([`GET /items/${PARENT}`, "GET /users/me", `PUT /items/${PARENT}`]);
  });

  it("o POST do pai SEM variações continua com o corpo de sempre", async () => {
    const { db } = fakeDb();
    const { client, bodies } = fakeClient();

    await run(db, client);

    expect(bodies[`POST /items/${PARENT}/relist`]).toEqual({ price: 199.9, quantity: 5, listing_type_id: "gold_special" });
  });

  it("REQUESTED com variações TODAS sem estoque: PREFLIGHT_FAILED (VARIACOES_SEM_ESTOQUE) e o pai nunca é fechado", async () => {
    const { db, updates, events } = fakeDb();
    const { client, calls } = fakeClient({
      parentBody: parentWithVariations({
        variations: [
          { id: 1, price: 10, available_quantity: 0 },
          { id: 2, price: 10, available_quantity: 0 },
        ],
      }),
    });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => update.patch.status)).toEqual(["PREFLIGHT_FAILED"]);
    expect(events.map((event) => event.reason)).toEqual(["VARIACOES_SEM_ESTOQUE"]);
    expect(calls.some((call) => call.startsWith("PUT") || call.startsWith("POST"))).toBe(false);
  });

  it("D-369: REQUESTED com variações de user products: PREFLIGHT_FAILED (VARIACOES_USER_PRODUCT) antes do PUT — nenhum PUT, nenhum POST", async () => {
    const { db, updates, events } = fakeDb();
    const { client, calls } = fakeClient({ parentBody: parentWithUserProductVariations() });
    const lines: string[] = [];

    const outcome = await run(db, client, { relistId: RELIST_ID }, lines);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => update.patch.status)).toEqual(["PREFLIGHT_FAILED"]);
    expect(events.map((event) => event.reason)).toEqual(["VARIACOES_USER_PRODUCT"]);
    expect(String(updates[0]?.patch.failure_reason)).toContain(
      "O Mercado Livre não permite republicar anúncio com variações de conta no modelo de user products",
    );
    // A variação com user_product_id já decide: a conta não é lida.
    expect(calls).toEqual([`GET /items/${PARENT}`]);
    expect(logs(lines).find((line) => line.message === "relist_execute_preflight")).toMatchObject({
      approved: false,
      blocks: ["VARIACOES_USER_PRODUCT"],
      seller_user_products: "nao_consultado",
    });
  });

  it("D-369 (A3): REQUESTED com variações SEM user_product_id e a conta com a tag user_product_seller: PREFLIGHT_FAILED antes do PUT", async () => {
    const { db, updates, events } = fakeDb();
    const { client, calls } = fakeClient({ parentBody: parentWithVariations(), sellerTags: TAGS_COM_UP });
    const lines: string[] = [];

    const outcome = await run(db, client, { relistId: RELIST_ID }, lines);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => update.patch.status)).toEqual(["PREFLIGHT_FAILED"]);
    expect(events.map((event) => event.reason)).toEqual(["VARIACOES_USER_PRODUCT"]);
    expect(calls).toEqual([`GET /items/${PARENT}`, "GET /users/me"]);
    expect(logs(lines).find((line) => line.message === "relist_execute_preflight")).toMatchObject({
      blocks: ["VARIACOES_USER_PRODUCT"],
      seller_user_products: true,
    });
  });

  it("D-369 (A3): leitura da conta que falha (5xx, 403 ou forma) reprova com USER_PRODUCT_NAO_VERIFICADO — nenhum PUT", async () => {
    for (const sellerTags of [
      new MercadoLivreApiError("Mercado Livre respondeu 503 para GET /users/me.", { status: 503, errorClass: "retryable", url: "/users/me" }),
      new MercadoLivreApiError("Mercado Livre respondeu 403 para GET /users/me.", { status: 403, errorClass: "not_retryable", url: "/users/me" }),
      new Error("forma inesperada"),
    ]) {
      const { db, updates, events } = fakeDb();
      const { client, calls } = fakeClient({ parentBody: parentWithVariations(), sellerTags });
      const lines: string[] = [];

      const outcome = await run(db, client, { relistId: RELIST_ID }, lines);

      expect(outcome).toEqual({ status: "done", processed: 1 });
      expect(updates.map((update) => update.patch.status)).toEqual(["PREFLIGHT_FAILED"]);
      expect(events.map((event) => event.reason)).toEqual(["USER_PRODUCT_NAO_VERIFICADO"]);
      expect(String(updates[0]?.patch.failure_reason)).toContain("não foi possível confirmar agora se a conta está no modelo de user products");
      expect(calls.some((call) => call.startsWith("PUT") || call.startsWith("POST"))).toBe(false);
      expect(logs(lines).some((line) => line.message === "relist_seller_model_unreadable")).toBe(true);
    }
  });

  it("D-369: SEM variações e com user_product_id na raiz, o pai é fechado e republicado como sempre", async () => {
    const { db, updates } = fakeDb();
    const { client, calls } = fakeClient({
      parentBody: healthyParent({ user_product_id: "MLBU3858499373" }),
      sellerTags: TAGS_COM_UP,
    });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => update.patch.status)).toEqual(["CLOSING", "CLOSED", "RELISTING", "RELISTED"]);
    expect(calls).toContain(`POST /items/${PARENT}/relist`);
    // A3: sem variações, nenhuma chamada à conta — nem com a conta no modelo de user products.
    expect(calls).not.toContain("GET /users/me");
  });

  it("retomada de CLOSED com o pai sem estoque: nem transição nem POST — o job falha sem retry", async () => {
    const { db, updates } = fakeDb({ operationStatus: "CLOSED" });
    const { client, calls } = fakeClient({
      parentBody: parentWithVariations({ status: "closed", variations: [{ id: 1, price: 10, available_quantity: 0 }] }),
    });

    const outcome = await run(db, client);

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(updates).toHaveLength(0);
    expect(calls).toEqual([`GET /items/${PARENT}`]);
  });

  it("400 com corpo de erro do ML: RELIST_FAILED com POST_RECUSADO, o resumo do corpo gravado e o log relist_post_rejected", async () => {
    const { db, updates, events } = fakeDb();
    const { client } = fakeClient({ parentBody: parentWithVariations(), relistOutcome: recusa400() });
    const lines: string[] = [];

    const outcome = await run(db, client, { relistId: RELIST_ID }, lines);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => update.patch.status)).toEqual(["CLOSING", "CLOSED", "RELISTING", "RELIST_FAILED"]);
    expect(events.at(-1)).toMatchObject({ to_status: "RELIST_FAILED", reason: "POST_RECUSADO" });

    const failureReason = String(updates.at(-1)?.patch.failure_reason);
    expect(failureReason.startsWith("o Mercado Livre recusou a republicação (HTTP 400) — nenhum anúncio novo foi criado")).toBe(
      true,
    );
    expect(failureReason).toContain("Validation error");
    expect(failureReason).toContain("item.variations.missing: Item with variations must be relisted with variations");

    const rejected = logs(lines).find((line) => line.message === "relist_post_rejected");
    expect(rejected).toMatchObject({ relist_id: RELIST_ID, status: 400 });
    expect(String(rejected?.summary)).toContain("item.variations.missing");
  });

  it("o resumo do corpo de erro não carrega token e é cortado em ~800 caracteres", async () => {
    const { db, updates } = fakeDb();
    const { client } = fakeClient({
      relistOutcome: recusa400({
        message: `recusado APP_USR-1234567890abcdef-token ${"x".repeat(2_000)}`,
        error: "bad_request",
        cause: [],
      }),
    });

    await run(db, client);

    const failureReason = String(updates.at(-1)?.patch.failure_reason);
    expect(failureReason).not.toContain("APP_USR-1234567890abcdef");
    expect(failureReason.length).toBeLessThan(1_000);
  });

  it("D-369 (A2): a causa item.variations.relist.invalid depois de 12 causas longas sobrevive ao corte — a recusa não volta a ser elegível", async () => {
    const causasAntes = Array.from({ length: 12 }, (_, indice) => ({
      code: `item.attributes.invalid_${String(indice + 1)}`,
      message: `Attribute ${String(indice + 1)} is invalid for this category and must be reviewed before any relist attempt`,
    }));
    const decisiva = {
      code: "item.variations.relist.invalid",
      message: "Relist item with variations are not allowed for user product seller",
    };

    // `message` e `error` longos (B2): cada um tem teto próprio, ou empurraria a decisiva para depois do corte.
    for (const { message, error } of [
      { message: "Validation error", error: "validation_error" },
      { message: `Validation error ${"x".repeat(2_000)}`, error: "validation_error" },
      { message: "Validation error", error: "e".repeat(2_000) },
    ]) {
      const { db, updates, events } = fakeDb();
      const { client } = fakeClient({
        relistOutcome: recusa400({ message, error, status: 400, cause: [...causasAntes, decisiva] }),
      });
      const lines: string[] = [];

      // Sem a ordem, o texto das 12 causas passaria dos 800 caracteres antes da decisiva.
      expect(causasAntes.map((causa) => `${causa.code}: ${causa.message}`).join("; ").length).toBeGreaterThan(800);

      await run(db, client, { relistId: RELIST_ID }, lines);

      const failureReason = String(updates.at(-1)?.patch.failure_reason);
      expect(events.at(-1)).toMatchObject({ to_status: "RELIST_FAILED", reason: "POST_RECUSADO" });
      expect(failureReason).toContain("causas: item.variations.relist.invalid: Relist item with variations are not allowed");
      expect(failureReason.length).toBeLessThan(1_000);
      expect(
        isRelistRetryEligible({ status: "RELIST_FAILED", parentItemId: PARENT, failureReason, lastFailedEventReason: "POST_RECUSADO" }),
      ).toBe(false);
      // As outras causas continuam no resumo, na ordem do ML, até o corte.
      expect(failureReason).toContain("item.attributes.invalid_1: Attribute 1");
      expect(String(logs(lines).find((line) => line.message === "relist_post_rejected")?.summary)).toContain(
        "item.variations.relist.invalid",
      );
    }
  });

  it("D-369 (R2): a causa decisiva sobrevive em qualquer forma legível do corpo — a recusa nunca volta a parecer retomável", async () => {
    const CODIGO = "item.variations.relist.invalid";
    const MENSAGEM = "Relist item with variations are not allowed for user product seller";
    const longas = Array.from({ length: 12 }, (_, indice) => `item.attributes.invalid_${String(indice + 1)}: ${"z".repeat(90)}`);

    // [nome, corpo, trecho que o resumo precisa manter além do código]
    const formas: readonly (readonly [string, unknown, string])[] = [
      ["cause como objeto único", { message: "Validation error", error: "validation_error", cause: { code: CODIGO, message: MENSAGEM } }, `${CODIGO}: ${MENSAGEM}`],
      ["cause como texto", { message: "Validation error", error: "validation_error", cause: `${CODIGO}: ${MENSAGEM}` }, `${CODIGO}: ${MENSAGEM}`],
      ["array de textos com a decisiva no fim", { message: "Validation error", cause: [...longas, `${CODIGO}: ${MENSAGEM}`] }, `causas: ${CODIGO}: ${MENSAGEM}`],
      ["código no fim de `error` com 300 caracteres", { message: "Validation error", error: `${"e".repeat(270)} ${CODIGO}`, cause: [] }, `causas: ${CODIGO}`],
      ["código no fim de `message` com 3.000 caracteres", { message: `${"m".repeat(3_000)} ${CODIGO}` }, `causas: ${CODIGO}`],
      ["código seguido do ponto final", { message: `Relist refused: ${CODIGO}.`, error: "validation_error", cause: [] }, `Relist refused: ${CODIGO}.`],
      ["corpo em texto longo", `${"t".repeat(2_000)} ${CODIGO}`, `causas: ${CODIGO}`],
      ["código num campo que o resumo não lê", { message: "Validation error", details: [{ reason: CODIGO }] }, `causas: ${CODIGO}`],
      [
        "causa decisiva com o código só no fim de uma mensagem longa",
        { message: "Validation error", cause: [...longas.map((texto) => ({ code: texto.split(":")[0], message: "z".repeat(90) })), { code: "item.invalid", message: `${"y".repeat(900)} ${CODIGO}` }] },
        `causas: ${CODIGO}; item.invalid: yyy`,
      ],
    ];

    for (const [nome, corpo, trecho] of formas) {
      const { db, updates, events } = fakeDb();
      const { client } = fakeClient({ relistOutcome: recusa400(corpo) });
      const lines: string[] = [];

      await run(db, client, { relistId: RELIST_ID }, lines);

      const failureReason = String(updates.at(-1)?.patch.failure_reason);
      expect(events.at(-1), nome).toMatchObject({ to_status: "RELIST_FAILED", reason: "POST_RECUSADO" });
      expect(failureReason, nome).toContain(trecho);
      expect(failureReason.length, nome).toBeLessThan(1_000);
      expect(isRelistUserProductVariationsRejection(failureReason), nome).toBe(true);
      expect(
        isRelistRetryEligible({ status: "RELIST_FAILED", parentItemId: PARENT, failureReason, lastFailedEventReason: "POST_RECUSADO" }),
        nome,
      ).toBe(false);
    }
  });

  it("D-369 (R2): sem a causa decisiva no corpo, nada é acrescentado — códigos parecidos continuam recusas retomáveis", async () => {
    for (const corpo of [
      { message: "Validation error", error: `${"e".repeat(270)} item.variations.relist.invalid_quantity`, cause: [] },
      { message: "Validation error", cause: { code: "item.variations.relist.invalid.quantity", message: "x" } },
      `${"t".repeat(2_000)} xitem.variations.relist.invalid`,
    ]) {
      const { db, updates } = fakeDb();
      const { client } = fakeClient({ relistOutcome: recusa400(corpo) });

      await run(db, client);

      const failureReason = String(updates.at(-1)?.patch.failure_reason);
      expect(failureReason).not.toMatch(/causas: item\.variations\.relist\.invalid(;|$)/u);
      expect(isRelistUserProductVariationsRejection(failureReason)).toBe(false);
      expect(
        isRelistRetryEligible({ status: "RELIST_FAILED", parentItemId: PARENT, failureReason, lastFailedEventReason: "POST_RECUSADO" }),
      ).toBe(true);
    }
  });

  it("500, 408 e 429 continuam POST_FALHOU — não é recusa comprovada", async () => {
    for (const [status, errorClass] of [
      [500, "retryable"],
      [408, "not_retryable"],
      [429, "retryable"],
    ] as const) {
      const { db, updates, events } = fakeDb();
      const { client } = fakeClient({
        relistOutcome: new MercadoLivreApiError(`Mercado Livre respondeu ${String(status)} para POST /items/${PARENT}/relist.`, {
          status,
          errorClass,
          url: "x",
        }),
      });

      const outcome = await run(db, client);

      expect(outcome).toEqual({ status: "done", processed: 1 });
      expect(updates.at(-1)?.patch.status).toBe("RELIST_FAILED");
      expect(events.at(-1)).toMatchObject({ to_status: "RELIST_FAILED", reason: "POST_FALHOU" });
      expect(String(updates.at(-1)?.patch.failure_reason)).toContain("não é seguro repetir");
    }
  });
});

describe("relist.execute — retomada humana depois de recusa (D-364)", () => {
  it("elegível (POST_RECUSADO): RELIST_FAILED → RELISTING → POST com variações → RELISTED e remapeamento", async () => {
    const { db, updates, events, rpcCalls } = fakeDb({
      operationStatus: "RELIST_FAILED",
      failureReason: RECUSA_GRAVADA,
      lastFailedReason: "POST_RECUSADO",
    });
    const { client, calls, bodies } = fakeClient({ parentBody: parentWithVariations({ status: "closed" }) });
    const lines: string[] = [];

    const outcome = await run(db, client, RETOMADA, lines);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => [update.fromStatus, update.patch.status])).toEqual([
      ["RELIST_FAILED", "RELISTING"],
      ["RELISTING", "RELISTED"],
    ]);
    // O CAS da retomada amarra a VERSÃO lida, não só o status (R1).
    expect(updates[0]?.filters).toEqual({ id: RELIST_ID, status: "RELIST_FAILED", updated_at: OPERATION_UPDATED_AT });
    expect(updates[1]?.filters).toEqual({ id: RELIST_ID, status: "RELISTING" });
    // O ato é humano: quem autorizou fica no evento; a transição seguinte é do sistema.
    expect(events.map((event) => event.actor_user_id)).toEqual([AUTORIZADO_POR, null]);
    expect(logs(lines).find((line) => line.message === "relist_retry_started")).toMatchObject({
      authorized_by: AUTORIZADO_POR,
      variations_left_out: ["180214523003"],
    });
    // O motivo antigo sai com a retomada; o filho é gravado no RELISTED.
    expect(updates[0]?.patch.failure_reason).toBeNull();
    expect(updates[1]?.patch.child_item_id).toBe(CHILD);
    expect(events.map((event) => [event.to_status, event.reason])).toEqual([
      ["RELISTING", "RETOMADA_APOS_RECUSA"],
      ["RELISTED", null],
    ]);
    // D-369: a conta é lida (sem a tag) antes do POST.
    expect(calls).toEqual([
      `GET /items/${PARENT}`,
      "GET /users/me",
      `POST /items/${PARENT}/relist`,
      `GET /items/${CHILD}?include_attributes=all`,
    ]);
    expect(bodies[`POST /items/${PARENT}/relist`]).toEqual(CORPO_COM_VARIACOES);
    expect(rpcCalls).toHaveLength(1);
  });

  it("elegível pelo LEGADO (POST_FALHOU com a mensagem antiga do 400): retoma igual", async () => {
    const { db, updates } = fakeDb({
      operationStatus: "RELIST_FAILED",
      failureReason: MENSAGEM_LEGADA_400,
      lastFailedReason: "POST_FALHOU",
    });
    const { client, calls } = fakeClient({ parentBody: parentWithVariations({ status: "closed" }) });

    const outcome = await run(db, client, RETOMADA);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => update.patch.status)).toEqual(["RELISTING", "RELISTED"]);
    expect(calls).toContain(`POST /items/${PARENT}/relist`);
  });

  it("recusada DE NOVO na retomada: volta a RELIST_FAILED com POST_RECUSADO (e segue elegível para outra decisão humana)", async () => {
    const { db, updates, events } = fakeDb({
      operationStatus: "RELIST_FAILED",
      failureReason: RECUSA_GRAVADA,
      lastFailedReason: "POST_RECUSADO",
    });
    const { client } = fakeClient({ parentBody: parentWithVariations({ status: "closed" }), relistOutcome: recusa400() });

    const outcome = await run(db, client, RETOMADA);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => update.patch.status)).toEqual(["RELISTING", "RELIST_FAILED"]);
    expect(events.at(-1)).toMatchObject({ reason: "POST_RECUSADO" });
  });

  it("NÃO elegível (o worker reaplica a regra): 5xx legado, EXECUCAO_INTERROMPIDA ou sem evento — nenhuma transição e nenhum POST", async () => {
    for (const options of [
      {
        failureReason: `o POST /relist falhou e não é seguro repetir: Mercado Livre respondeu 500 para POST /items/${PARENT}/relist.`,
        lastFailedReason: "POST_FALHOU",
      },
      { failureReason: MENSAGEM_LEGADA_400, lastFailedReason: "EXECUCAO_INTERROMPIDA" },
      { failureReason: MENSAGEM_LEGADA_400, lastFailedReason: "RESPOSTA_AMBIGUA" },
      { failureReason: MENSAGEM_LEGADA_400 },
    ]) {
      const { db, updates, events } = fakeDb({ operationStatus: "RELIST_FAILED", ...options });
      const { client, calls } = fakeClient({ parentBody: parentWithVariations({ status: "closed" }) });

      const outcome = await run(db, client, RETOMADA);

      expect(outcome).toEqual({ status: "done", processed: 0 });
      expect(updates).toHaveLength(0);
      expect(events).toHaveLength(0);
      expect(calls.some((call) => call.startsWith("POST"))).toBe(false);
    }
  });

  it("pai que NÃO está closed no remoto: nenhuma transição e nenhum POST", async () => {
    const { db, updates } = fakeDb({ operationStatus: "RELIST_FAILED", failureReason: RECUSA_GRAVADA, lastFailedReason: "POST_RECUSADO" });
    const { client, calls } = fakeClient({ parentBody: parentWithVariations({ status: "active" }) });
    const lines: string[] = [];

    const outcome = await run(db, client, RETOMADA, lines);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(updates).toHaveLength(0);
    expect(calls).toEqual([`GET /items/${PARENT}`]);
    expect(logs(lines).some((line) => line.message === "relist_retry_parent_not_closed")).toBe(true);
  });

  it("pai com a tag `relist` (já republicado) ou sem tags legíveis: nenhuma transição e nenhum POST", async () => {
    for (const tags of [["relist"], undefined]) {
      const { db, updates } = fakeDb({ operationStatus: "RELIST_FAILED", failureReason: RECUSA_GRAVADA, lastFailedReason: "POST_RECUSADO" });
      const { client, calls } = fakeClient({ parentBody: parentWithVariations({ status: "closed", tags }) });

      const outcome = await run(db, client, RETOMADA);

      expect(outcome).toEqual({ status: "done", processed: 0 });
      expect(updates).toHaveLength(0);
      expect(calls).toEqual([`GET /items/${PARENT}`]);
    }
  });

  it("D-369: variações de user products — a recusa com a causa não é elegível, e outra recusa com o pai nessa forma também não emite o POST", async () => {
    // (a) A recusa REAL da a7638dc5: a regra de elegibilidade barra antes de qualquer leitura remota.
    {
      const { db, updates, events } = fakeDb({
        operationStatus: "RELIST_FAILED",
        failureReason: RECUSA_USER_PRODUCT,
        lastFailedReason: "POST_RECUSADO",
      });
      const { client, calls } = fakeClient({ parentBody: parentWithUserProductVariations({ status: "closed" }) });
      const lines: string[] = [];

      const outcome = await run(db, client, RETOMADA, lines);

      expect(outcome).toEqual({ status: "done", processed: 0 });
      expect(updates).toHaveLength(0);
      expect(events).toHaveLength(0);
      expect(calls).toEqual([]);
      expect(logs(lines).find((line) => line.message === "relist_retry_not_eligible")).toMatchObject({
        user_product_variations_rejection: true,
      });
    }

    // (b) Recusa elegível por OUTRA causa, e o pai ao vivo com variações de user products: nada sai.
    {
      const { db, updates, events } = fakeDb({
        operationStatus: "RELIST_FAILED",
        failureReason: RECUSA_GRAVADA,
        lastFailedReason: "POST_RECUSADO",
      });
      const { client, calls } = fakeClient({ parentBody: parentWithUserProductVariations({ status: "closed" }) });
      const lines: string[] = [];

      const outcome = await run(db, client, RETOMADA, lines);

      expect(outcome).toEqual({ status: "done", processed: 0 });
      expect(updates).toHaveLength(0);
      expect(events).toHaveLength(0);
      expect(calls).toEqual([`GET /items/${PARENT}`]);
      expect(logs(lines).some((line) => line.message === "relist_retry_user_product_variations")).toBe(true);
    }

    // (c) A3: outra recusa, variações SEM user_product_id e a conta com a tag (ou sem leitura): nada sai.
    for (const [sellerTags, block] of [
      [TAGS_COM_UP, "VARIACOES_USER_PRODUCT"],
      [new Error("sem resposta"), "USER_PRODUCT_NAO_VERIFICADO"],
    ] as const) {
      const { db, updates, events } = fakeDb({
        operationStatus: "RELIST_FAILED",
        failureReason: RECUSA_GRAVADA,
        lastFailedReason: "POST_RECUSADO",
      });
      const { client, calls } = fakeClient({ parentBody: parentWithVariations({ status: "closed" }), sellerTags });
      const lines: string[] = [];

      const outcome = await run(db, client, RETOMADA, lines);

      expect(outcome).toEqual({ status: "done", processed: 0 });
      expect(updates).toHaveLength(0);
      expect(events).toHaveLength(0);
      expect(calls).toEqual([`GET /items/${PARENT}`, "GET /users/me"]);
      expect(logs(lines).find((line) => line.message === "relist_retry_user_product_variations")).toMatchObject({ block });
    }
  });

  it("pai fechado mas sem estoque em variação nenhuma: nenhuma transição e nenhum POST", async () => {
    const { db, updates } = fakeDb({ operationStatus: "RELIST_FAILED", failureReason: RECUSA_GRAVADA, lastFailedReason: "POST_RECUSADO" });
    const { client, calls } = fakeClient({
      parentBody: parentWithVariations({ status: "closed", variations: [{ id: 1, price: 10, available_quantity: 0 }] }),
    });

    const outcome = await run(db, client, RETOMADA);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(updates).toHaveLength(0);
    expect(calls).toEqual([`GET /items/${PARENT}`, "GET /users/me"]);
  });

  it("CAS perdido na retomada é outra execução que assumiu: termina SEM retry e sem POST", async () => {
    const { db, events } = fakeDb({
      operationStatus: "RELIST_FAILED",
      failureReason: RECUSA_GRAVADA,
      lastFailedReason: "POST_RECUSADO",
      updateReturnsEmpty: true,
    });
    const { client, calls } = fakeClient({ parentBody: parentWithVariations({ status: "closed" }) });

    const outcome = await run(db, client, RETOMADA);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(events).toHaveLength(0);
    expect(calls.some((call) => call.startsWith("POST"))).toBe(false);
  });

  it("RELIST_FAILED SEM retomada continua noop — mesmo recusado, nada repete sozinho", async () => {
    const { db, updates } = fakeDb({ operationStatus: "RELIST_FAILED", lastFailedReason: "POST_RECUSADO" });
    const { client, calls } = fakeClient({ parentBody: parentWithVariations({ status: "closed" }) });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(updates).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("retomada SEM quem autorizou é payload inválido: nada é lido nem chamado", async () => {
    const { db, updates } = fakeDb({ operationStatus: "RELIST_FAILED", failureReason: RECUSA_GRAVADA, lastFailedReason: "POST_RECUSADO" });
    const { client, calls } = fakeClient({ parentBody: parentWithVariations({ status: "closed" }) });

    const outcome = await run(db, client, { relistId: RELIST_ID, retomada: true });

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(updates).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("recusa antiga seguida de 5xx na retomada (a última falha é POST_FALHOU): não elegível, nenhum POST", async () => {
    const { db, updates, events } = fakeDb({
      operationStatus: "RELIST_FAILED",
      failureReason: `o POST /relist falhou e não é seguro repetir: Mercado Livre respondeu 502 para POST /items/${PARENT}/relist.`,
      eventHistory: [
        falhaRegistrada("POST_RECUSADO", "2026-09-16T18:41:12.000000+00:00"),
        falhaRegistrada("RETOMADA_APOS_RECUSA", "2026-09-17T10:00:00.000000+00:00", { to_status: "RELISTING" }),
        falhaRegistrada("POST_FALHOU", "2026-09-17T10:00:05.000000+00:00"),
      ],
    });
    const { client, calls } = fakeClient({ parentBody: parentWithVariations({ status: "closed" }) });

    const outcome = await run(db, client, RETOMADA);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(updates).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("o que decide é a ÚLTIMA entrada em RELIST_FAILED DESTA operação — nem a primeira, nem a de outra, nem outra transição", async () => {
    for (const eventHistory of [
      // A a7638dc5 retomada e recusada de novo: o legado antigo não decide mais.
      [
        falhaRegistrada("POST_FALHOU", "2026-09-16T18:41:12.000000+00:00"),
        falhaRegistrada("RETOMADA_APOS_RECUSA", "2026-09-17T10:00:00.000000+00:00", { to_status: "RELISTING" }),
        falhaRegistrada("POST_RECUSADO", "2026-09-17T10:00:05.000000+00:00"),
      ],
      // A falha mais recente é de OUTRA operação.
      [
        falhaRegistrada("POST_RECUSADO", "2026-09-17T10:00:05.000000+00:00"),
        falhaRegistrada("POST_FALHOU", "2026-09-17T11:00:00.000000+00:00", { relist_id: "cccccccc-0000-4000-8000-000000000002" }),
      ],
      // Depois da recusa, só uma transição para OUTRO estado foi gravada.
      [
        falhaRegistrada("POST_RECUSADO", "2026-09-17T10:00:05.000000+00:00"),
        falhaRegistrada("RETOMADA_APOS_RECUSA", "2026-09-17T11:00:00.000000+00:00", { to_status: "RELISTING" }),
      ],
    ]) {
      const { db, updates } = fakeDb({ operationStatus: "RELIST_FAILED", failureReason: RECUSA_GRAVADA, eventHistory });
      const { client, calls } = fakeClient({ parentBody: parentWithVariations({ status: "closed" }) });

      const outcome = await run(db, client, RETOMADA);

      expect(outcome).toEqual({ status: "done", processed: 1 });
      expect(updates.map((update) => update.patch.status)).toEqual(["RELISTING", "RELISTED"]);
      expect(calls).toContain(`POST /items/${PARENT}/relist`);
    }
  });

  it("retomada pedida para operação REQUESTED é noop — ela nunca fecha pai", async () => {
    const { db, updates } = fakeDb({ operationStatus: "REQUESTED", lastFailedReason: "POST_RECUSADO" });
    const { client, calls } = fakeClient();

    const outcome = await run(db, client, RETOMADA);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(updates).toHaveLength(0);
    expect(calls).toEqual([]);
  });
});

/**
 * Banco COM ESTADO para as intercalações da retomada (achado R1 da revisão de
 * D-364): a linha muda de verdade, o `updated_at` anda a cada update (o
 * trigger `listing_relists_set_updated_at`), o CAS aplica TODOS os `.eq` e os
 * eventos entram no histórico que a próxima leitura vê. O resto (token,
 * medição) vem do `fakeDb` comum.
 */
function statefulDb(initial: { status: string; failure_reason: string; events: EventRow[] }): {
  db: RelistExecuteDeps["db"];
  row: Record<string, unknown>;
  events: EventRow[];
  casLog: string[];
} {
  const base = fakeDb();
  const events = [...initial.events];
  const casLog: string[] = [];
  let version = 0;
  const row: Record<string, unknown> = {
    id: RELIST_ID,
    organization_id: ORGANIZATION_ID,
    ml_account_id: ML_ACCOUNT_ID,
    parent_item_id: PARENT,
    child_item_id: null,
    status: initial.status,
    failure_reason: initial.failure_reason,
    requested_by: REQUESTED_BY,
    updated_at: OPERATION_UPDATED_AT,
  };

  const db = {
    from: (table: string) => {
      if (table === "listing_relists") {
        return {
          select: () => chain({ data: { ...row }, error: null }),
          update: (patch: Record<string, unknown>) => {
            const filters: Record<string, unknown> = {};
            const builder = {
              eq: (column: string, value: unknown) => {
                filters[column] = value;

                return builder;
              },
              select: () => {
                if (!Object.entries(filters).every(([column, value]) => row[column] === value)) {
                  return Promise.resolve({ data: [], error: null });
                }

                version += 1;
                casLog.push(`${String(row.status)}→${String(patch.status)}`);
                Object.assign(row, patch, { updated_at: `2026-09-17T10:00:${String(version).padStart(2, "0")}.000000+00:00` });

                return Promise.resolve({ data: [{ id: RELIST_ID }], error: null });
              },
            };

            return builder;
          },
        };
      }

      if (table === "listing_relist_events") {
        return {
          select: () => historyQuery(events),
          insert: (event: Record<string, unknown>) => {
            events.push({
              relist_id: String(event.relist_id),
              to_status: String(event.to_status),
              reason: (event.reason as string | null | undefined) ?? null,
              occurred_at: `2026-09-17T10:00:${String(events.length).padStart(2, "0")}.500000+00:00`,
            });

            return Promise.resolve({ error: null });
          },
        };
      }

      return base.db.from(table as never);
    },
    rpc: (name: string, args: Record<string, unknown>) => base.db.rpc(name as never, args as never),
  } as unknown as RelistExecuteDeps["db"];

  return { db, row, events, casLog };
}

describe("relist.execute — retomadas concorrentes (D-364, achado R1)", () => {
  it("B leu a operação elegível; A retomou, emitiu o POST e voltou a RELIST_FAILED (5xx ou resposta ambígua): B perde o CAS e NÃO emite o 2º POST", async () => {
    for (const outcomeOfA of [
      new MercadoLivreApiError(`Mercado Livre respondeu 500 para POST /items/${PARENT}/relist.`, {
        status: 500,
        errorClass: "retryable",
        url: "x",
      }),
      { id: PARENT },
    ]) {
      const { db, row, events, casLog } = statefulDb({
        status: "RELIST_FAILED",
        failure_reason: RECUSA_GRAVADA,
        events: [falhaRegistrada("POST_RECUSADO", "2026-09-16T18:41:12.000000+00:00")],
      });
      const posts: string[] = [];
      let bReachedGet: () => void = () => undefined;
      const bAtGet = new Promise<void>((resolve) => {
        bReachedGet = resolve;
      });
      let releaseB: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseB = resolve;
      });

      /** O cliente de uma das retomadas: conta os POSTs; o de B segura o GET do pai. */
      function clientOf(base: MercadoLivreClient, holdGet: boolean): MercadoLivreClient {
        return {
          request: async (request: RequestOptions<unknown>) => {
            if (request.method === "GET" && holdGet) {
              bReachedGet();
              await gate;
            }

            if (request.method === "POST") {
              posts.push(request.path);
            }

            return base.request(request);
          },
        } as unknown as MercadoLivreClient;
      }

      const parentBody = parentWithVariations({ status: "closed" });
      const lines: string[] = [];
      const runB = run(db, clientOf(fakeClient({ parentBody }).client, true), RETOMADA, lines);

      await bAtGet;
      const outcomeA = await run(db, clientOf(fakeClient({ parentBody, relistOutcome: outcomeOfA }).client, false), RETOMADA);

      // O estado que A deixou NÃO é elegível — é exatamente o que B não pode atropelar.
      expect(outcomeA).toEqual({ status: "done", processed: 1 });
      expect(row.status).toBe("RELIST_FAILED");
      expect(
        isRelistRetryEligible({
          status: String(row.status),
          parentItemId: PARENT,
          failureReason: row.failure_reason as string,
          lastFailedEventReason: events.filter((event) => event.to_status === "RELIST_FAILED").at(-1)?.reason ?? null,
        }),
      ).toBe(false);

      releaseB();
      const outcomeB = await runB;

      expect(outcomeB).toEqual({ status: "done", processed: 0 });
      expect(posts).toEqual([`/items/${PARENT}/relist`]);
      expect(casLog).toEqual(["RELIST_FAILED→RELISTING", "RELISTING→RELIST_FAILED"]);
      expect(events.map((event) => event.reason)).toEqual([
        "POST_RECUSADO",
        "RETOMADA_APOS_RECUSA",
        outcomeOfA instanceof Error ? "POST_FALHOU" : "RESPOSTA_AMBIGUA",
      ]);
      expect(logs(lines).some((line) => line.message === "relist_retry_superseded")).toBe(true);
    }
  });
});

describe("relist.execute — o POST /relist sai com UMA tentativa no cliente real (D-364, achado R3)", () => {
  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  it("503 e depois 400: o cliente não repete — POST_FALHOU (não é recusa comprovada) e a operação não fica elegível", async () => {
    for (const cenario of [
      { payload: { relistId: RELIST_ID }, parent: healthyParent(), options: {} },
      {
        payload: RETOMADA,
        parent: parentWithVariations({ status: "closed" }),
        options: { operationStatus: "RELIST_FAILED", failureReason: RECUSA_GRAVADA, lastFailedReason: "POST_RECUSADO" },
      },
    ]) {
      const { db, updates, events } = fakeDb(cenario.options);
      const posts: string[] = [];
      const postAnswers = [
        jsonResponse(503, { message: "service unavailable" }),
        jsonResponse(400, { message: "item already relisted", error: "bad_request", cause: [] }),
      ];
      const client = createMercadoLivreClient({
        sleep: () => Promise.resolve(),
        fetchImpl: (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : input);

          if (init?.method === "POST") {
            posts.push(url.pathname);

            return Promise.resolve(postAnswers.shift() ?? jsonResponse(500, {}));
          }

          if (init?.method === "PUT") {
            return Promise.resolve(jsonResponse(200, { id: PARENT, status: "closed" }));
          }

          if (url.pathname === "/users/me") {
            return Promise.resolve(jsonResponse(200, { id: 244_878_077, tags: TAGS_SEM_UP }));
          }

          return Promise.resolve(jsonResponse(200, cenario.parent));
        },
      });

      const outcome = await run(db, client, cenario.payload);

      expect(outcome).toEqual({ status: "done", processed: 1 });
      expect(posts).toEqual([`/items/${PARENT}/relist`]);
      expect(events.at(-1)).toMatchObject({ to_status: "RELIST_FAILED", reason: "POST_FALHOU" });

      const failureReason = String(updates.at(-1)?.patch.failure_reason);
      expect(failureReason).toContain("503");
      expect(failureReason).not.toContain("nenhum anúncio novo foi criado");
      expect(
        isRelistRetryEligible({ status: "RELIST_FAILED", parentItemId: PARENT, failureReason, lastFailedEventReason: "POST_FALHOU" }),
      ).toBe(false);
    }
  });
});
