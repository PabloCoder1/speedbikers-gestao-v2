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
const REQUESTED_BY = "bbbbbbbb-0000-4000-8000-000000000002";
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

interface FakeDbOptions {
  operationStatus?: string;
  childItemId?: string | null;
  operationMissing?: boolean;
  updateReturnsEmpty?: boolean;
  remapError?: string;
  failureReason?: string | null;
  /** reason do último evento RELIST_FAILED; ausente = nenhum evento. */
  lastFailedReason?: string | null;
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
                },
            error: null,
          });
        }

        // Retomada (D-364): o último evento RELIST_FAILED da operação.
        if (table === "listing_relist_events") {
          return chain({
            data: options.lastFailedReason === undefined ? null : { reason: options.lastFailedReason },
            error: null,
          });
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
}

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
  it("caminho feliz: confirma o filho e conclui o remapeamento transacional", async () => {
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

const RETOMADA = { relistId: RELIST_ID, retomada: true };

/** A mensagem que o executor gravava antes de D-364 para o 400 (a operação a7638dc5, com o MLB deste teste). */
const MENSAGEM_LEGADA_400 = `o POST /relist falhou e não é seguro repetir: Mercado Livre respondeu 400 para POST /items/${PARENT}/relist.`;

describe("relist.execute com variações e recusa do ML (D-364)", () => {
  it("o POST do pai COM variações leva listing_type_id + variations com preço próprio, sem a zerada e sem price/quantity na raiz", async () => {
    const { db, updates } = fakeDb();
    const { client, bodies } = fakeClient({ parentBody: parentWithVariations() });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => update.patch.status)).toEqual(["CLOSING", "CLOSED", "RELISTING", "RELISTED"]);
    expect(bodies[`POST /items/${PARENT}/relist`]).toEqual(CORPO_COM_VARIACOES);
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
      failureReason: "o Mercado Livre recusou a republicação (HTTP 400) — nenhum anúncio novo foi criado. Resposta: x",
      lastFailedReason: "POST_RECUSADO",
    });
    const { client, calls, bodies } = fakeClient({ parentBody: parentWithVariations({ status: "closed" }) });

    const outcome = await run(db, client, RETOMADA);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(updates.map((update) => [update.fromStatus, update.patch.status])).toEqual([
      ["RELIST_FAILED", "RELISTING"],
      ["RELISTING", "RELISTED"],
    ]);
    // O motivo antigo sai com a retomada; o filho é gravado no RELISTED.
    expect(updates[0]?.patch.failure_reason).toBeNull();
    expect(updates[1]?.patch.child_item_id).toBe(CHILD);
    expect(events.map((event) => [event.to_status, event.reason])).toEqual([
      ["RELISTING", "RETOMADA_APOS_RECUSA"],
      ["RELISTED", null],
    ]);
    expect(calls).toEqual([
      `GET /items/${PARENT}`,
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
    const { db, updates, events } = fakeDb({ operationStatus: "RELIST_FAILED", lastFailedReason: "POST_RECUSADO" });
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
    const { db, updates } = fakeDb({ operationStatus: "RELIST_FAILED", lastFailedReason: "POST_RECUSADO" });
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
      const { db, updates } = fakeDb({ operationStatus: "RELIST_FAILED", lastFailedReason: "POST_RECUSADO" });
      const { client, calls } = fakeClient({ parentBody: parentWithVariations({ status: "closed", tags }) });

      const outcome = await run(db, client, RETOMADA);

      expect(outcome).toEqual({ status: "done", processed: 0 });
      expect(updates).toHaveLength(0);
      expect(calls).toEqual([`GET /items/${PARENT}`]);
    }
  });

  it("pai fechado mas sem estoque em variação nenhuma: nenhuma transição e nenhum POST", async () => {
    const { db, updates } = fakeDb({ operationStatus: "RELIST_FAILED", lastFailedReason: "POST_RECUSADO" });
    const { client, calls } = fakeClient({
      parentBody: parentWithVariations({ status: "closed", variations: [{ id: 1, price: 10, available_quantity: 0 }] }),
    });

    const outcome = await run(db, client, RETOMADA);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(updates).toHaveLength(0);
    expect(calls).toEqual([`GET /items/${PARENT}`]);
  });

  it("CAS perdido na retomada é outra execução que assumiu: termina SEM retry e sem POST", async () => {
    const { db, events } = fakeDb({
      operationStatus: "RELIST_FAILED",
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

  it("retomada pedida para operação REQUESTED é noop — ela nunca fecha pai", async () => {
    const { db, updates } = fakeDb({ operationStatus: "REQUESTED", lastFailedReason: "POST_RECUSADO" });
    const { client, calls } = fakeClient();

    const outcome = await run(db, client, RETOMADA);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(updates).toHaveLength(0);
    expect(calls).toEqual([]);
  });
});
