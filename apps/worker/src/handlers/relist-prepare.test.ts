import { randomBytes } from "node:crypto";

import { MercadoLivreApiError, encryptToken } from "@sb/mercado-livre";
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

interface FakeClientOptions {
  /** Estoque do Full por inventory_id: corpo da resposta ou erro lançado (D-360). Ausente = 404. */
  fullStock?: Record<string, Record<string, unknown> | Error>;
}

function fakeClient(
  entries: { code: number; body: unknown }[],
  options: FakeClientOptions = {},
): {
  client: MercadoLivreClient;
  requests: RequestOptions<unknown>[];
} {
  const requests: RequestOptions<unknown>[] = [];

  const client = {
    request: (request: RequestOptions<unknown>) => {
      requests.push(request);

      const inventory = /^\/inventories\/([^/]+)\/stock\/fulfillment$/.exec(request.path);

      if (inventory !== null) {
        const answer = options.fullStock?.[inventory[1] ?? ""];

        if (answer === undefined) {
          return Promise.reject(
            new MercadoLivreApiError("inventário não encontrado", { status: 404, errorClass: "not_retryable", url: request.path }),
          );
        }

        // Como o cliente real: a resposta atravessa o schema do chamador.
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(request.schema.parse(answer));
      }

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
    const { client, requests } = fakeClient([{ code: 200, body: healthyItemBody() }]);

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

    // Item fora do Full: nenhuma leitura de estoque do Full.
    expect(requests).toHaveLength(1);
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

describe("relist.prepare com cadastro no Full (D-360)", () => {
  it("o caso de produção: cadastro no Full ZERADO e envio por coleta — a operação fica REQUESTED, aprovável", async () => {
    const { db, relistUpdates, eventInserts } = fakeDb();
    const { client, requests } = fakeClient(
      [
        {
          code: 200,
          body: { ...healthyItemBody(), inventory_id: "TBWT07652", shipping: { mode: "me2", logistic_type: "cross_docking" } },
        },
      ],
      { fullStock: { TBWT07652: { inventory_id: "TBWT07652", available_quantity: 0, not_available_quantity: 0 } } },
    );

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(relistUpdates).toHaveLength(0);
    expect(eventInserts).toHaveLength(1);
    expect(requests.map((request) => request.path)).toContain("/inventories/TBWT07652/stock/fulfillment");
  });

  it("unidades no Full reprovam com a quantidade no motivo", async () => {
    const { db, relistUpdates, eventInserts } = fakeDb();
    const { client } = fakeClient([{ code: 200, body: { ...healthyItemBody(), inventory_id: "LCQI05831" } }], {
      fullStock: { LCQI05831: { inventory_id: "LCQI05831", available_quantity: 2, not_available_quantity: 1 } },
    });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(relistUpdates[0]).toMatchObject({ status: "PREFLIGHT_FAILED" });
    expect(String(relistUpdates[0]?.failure_reason)).toContain("3 unidade(s)");
    expect(eventInserts[1]).toMatchObject({ reason: "FULL_BLOQUEADO" });
  });

  it("estoque do Full ilegível (404 ou resposta sem os campos) reprova com FULL_NAO_VERIFICADO — nunca presume zero", async () => {
    for (const fullStock of [{}, { TBWT07652: { inventory_id: "TBWT07652", available_quantity: 0 } }]) {
      const { db, relistUpdates, eventInserts } = fakeDb();
      const { client } = fakeClient([{ code: 200, body: { ...healthyItemBody(), inventory_id: "TBWT07652" } }], {
        fullStock,
      });

      const outcome = await run(db, client);

      expect(outcome).toEqual({ status: "done", processed: 1 });
      expect(relistUpdates[0]).toMatchObject({ status: "PREFLIGHT_FAILED" });
      expect(eventInserts[1]).toMatchObject({ reason: "FULL_NAO_VERIFICADO" });
    }
  });

  it("resposta de OUTRO inventário não confere nada: FULL_NAO_VERIFICADO, mesmo com zero unidades", async () => {
    const { db, relistUpdates, eventInserts } = fakeDb();
    const { client } = fakeClient([{ code: 200, body: { ...healthyItemBody(), inventory_id: "TBWT07652" } }], {
      fullStock: { TBWT07652: { inventory_id: "LCQI05831", available_quantity: 0, not_available_quantity: 0 } },
    });

    const outcome = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(relistUpdates[0]).toMatchObject({ status: "PREFLIGHT_FAILED" });
    expect(eventInserts[1]).toMatchObject({ reason: "FULL_NAO_VERIFICADO" });
  });

  it("falha passageira ao ler o Full relança ANTES de criar a operação — o retry não cai num 23505 sem preflight", async () => {
    const { db, relistInserts } = fakeDb();
    const { client } = fakeClient([{ code: 200, body: { ...healthyItemBody(), inventory_id: "TBWT07652" } }], {
      fullStock: {
        TBWT07652: new MercadoLivreApiError("serviço indisponível", { status: 503, errorClass: "retryable", url: "/inventories" }),
      },
    });

    await expect(run(db, client)).rejects.toThrow("serviço indisponível");
    expect(relistInserts).toHaveLength(0);
  });
});
