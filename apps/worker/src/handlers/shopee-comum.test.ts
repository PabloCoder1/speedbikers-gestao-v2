import { randomBytes } from "node:crypto";

import type { JobEnvelope } from "@sb/contracts";
import { encryptToken } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { createShopeeClient } from "@sb/shopee";
import { describe, expect, it } from "vitest";

import { lerLojaConectada, type ShopeeJobDeps } from "./shopee-comum.js";
import { createShopeeItemsHydrateHandler } from "./shopee-items-hydrate.js";
import { createShopeeItemsSyncHandler } from "./shopee-items-sync.js";

const KEY = randomBytes(32);
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const LOJA_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-13T15:00:00.000Z");

const ENVELOPE: JobEnvelope = {
  jobId: "33333333-3333-4333-8333-333333333333",
  jobType: "shopee.items.sync",
  organizationId: ORG,
  dedupeKey: "k",
  attempt: 1,
  enqueuedAt: NOW.toISOString(),
};

const LOJA = {
  id: LOJA_ID,
  organization_id: ORG,
  environment: "sandbox",
  shop_id: 54804,
  status: "CONNECTED",
  orders_synced_until: null,
  items_synced_until: null,
  shop_name: "Loja Teste",
};

const CREDENCIAL = {
  access_token_ciphertext: encryptToken("access", KEY),
  refresh_token_ciphertext: encryptToken("refresh", KEY),
  access_token_expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
  refresh_token_expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
};

function makeClient(fetchImpl: (url: URL) => Promise<Response>) {
  return createShopeeClient({
    environment: "sandbox",
    partnerId: 1248019,
    partnerKey: "chave-de-teste-nao-real",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW,
  });
}

function makeDeps(overrides: {
  db?: ShopeeJobDeps["db"];
  fetchImpl?: (url: URL) => Promise<Response>;
  enqueueError?: Error;
}): ShopeeJobDeps {
  const defaultDb = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({ data: table === "shopee_shops" ? LOJA : CREDENCIAL, error: null }),
        }),
      }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      upsert: () => Promise.resolve({ error: null }),
    }),
  } as unknown as ShopeeJobDeps["db"];

  return {
    db: overrides.db ?? defaultDb,
    client: makeClient(
      overrides.fetchImpl ??
        (() =>
          Promise.resolve(
            new Response(JSON.stringify({ request_id: "r", response: { item: [], total_count: 0, has_next_page: false } }), {
              status: 200,
            }),
          )),
    ),
    encryptionKey: KEY,
    now: () => NOW,
    enqueuer: {
      enqueue: () =>
        overrides.enqueueError === undefined
          ? Promise.resolve({ deduplicated: false })
          : Promise.reject(overrides.enqueueError),
    } as unknown as ShopeeJobDeps["enqueuer"],
  };
}

describe("shopee-comum — isolamento multi-tenant e enqueue (D-818)", () => {
  it("lerLojaConectada recusa loja de outra organização quando expectedOrganizationId diverge", async () => {
    const deps = makeDeps({});
    const res = await lerLojaConectada(
      deps,
      { logger: createLogger({}, { sink: () => undefined }), payload: { shopeeShopId: LOJA_ID } },
      "skipped",
      OTHER_ORG,
    );

    expect("outcome" in res).toBe(true);
    if ("outcome" in res) {
      expect(res.outcome).toMatchObject({ status: "failed", retryable: false });
    }
  });

  it("lerLojaConectada mantém retrocompatibilidade quando expectedOrganizationId é omitido ou confere", async () => {
    const deps = makeDeps({});
    const ctx = { logger: createLogger({}, { sink: () => undefined }), payload: { shopeeShopId: LOJA_ID } };

    const sem = await lerLojaConectada(deps, ctx, "skipped");
    const igual = await lerLojaConectada(deps, ctx, "skipped", ORG);

    expect("loja" in sem).toBe(true);
    expect("loja" in igual).toBe(true);
  });

  it("shopee.items.sync recusa sem repetir quando a loja pertence a outra organização", async () => {
    const chamadas: string[] = [];
    const deps = makeDeps({
      fetchImpl: (url) => {
        chamadas.push(url.pathname);

        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    });
    const handler = createShopeeItemsSyncHandler(deps);

    const outcome = await handler(
      { ...ENVELOPE, organizationId: OTHER_ORG },
      { logger: createLogger({}, { sink: () => undefined }), payload: { shopeeShopId: LOJA_ID } },
    );

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(chamadas).toEqual([]);
  });

  it("shopee.items.sync devolve retryable=true e registra log quando o enqueue de hydrate falha", async () => {
    const lines: string[] = [];
    const deps = makeDeps({ enqueueError: new Error("cloud tasks down") });
    const handler = createShopeeItemsSyncHandler(deps);

    const outcome = await handler(ENVELOPE, {
      logger: createLogger({}, { sink: (line) => lines.push(line) }),
      payload: { shopeeShopId: LOJA_ID },
    });

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(lines.join("\n")).toContain("shopee_items_hydrate_enqueue_failed");
  });

  it("shopee.items.hydrate recusa sem repetir quando a loja pertence a outra organização", async () => {
    let rpcChamado = false;
    const db = {
      rpc: () => {
        rpcChamado = true;

        return Promise.resolve({ data: true, error: null });
      },
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: table === "shopee_shops" ? LOJA : CREDENCIAL, error: null }),
          }),
        }),
      }),
    } as unknown as ShopeeJobDeps["db"];
    const handler = createShopeeItemsHydrateHandler(makeDeps({ db }));

    const outcome = await handler(
      { ...ENVELOPE, jobType: "shopee.items.hydrate", organizationId: OTHER_ORG },
      { logger: createLogger({}, { sink: () => undefined }), payload: { shopeeShopId: LOJA_ID } },
    );

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(rpcChamado).toBe(false);
  });

  it("shopee.items.hydrate devolve retryable=true e registra log quando o enqueue de continuação falha", async () => {
    const lines: string[] = [];
    const pendentes = Array.from({ length: 50 }, (_, i) => ({
      item_id: 1000 + i,
      shopee_updated_at: NOW.toISOString(),
    }));
    const chain = {
      order: () => chain,
      range: () => Promise.resolve({ data: [], error: null }),
      then: (resolve: (value: { data: unknown[]; error: null }) => void) => {
        resolve({ data: [], error: null });
      },
    };
    const db = {
      rpc: (name: string) => {
        if (name === "shopee_items_hydrate_lock") return Promise.resolve({ data: true, error: null });
        if (name === "shopee_items_details_pending") return Promise.resolve({ data: pendentes, error: null });

        return Promise.resolve({ data: null, error: null });
      },
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: table === "shopee_shops" ? LOJA : CREDENCIAL, error: null }),
            in: () => chain,
          }),
        }),
        update: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ error: null }),
            is: () => Promise.resolve({ error: null }),
            then: (resolve: (value: { error: null }) => void) => {
              resolve({ error: null });
            },
          }),
        }),
      }),
    } as unknown as ShopeeJobDeps["db"];
    const deps = makeDeps({
      db,
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ request_id: "r", response: { item_list: [] } }), { status: 200 }),
        ),
      enqueueError: new Error("cloud tasks timeout"),
    });
    const handler = createShopeeItemsHydrateHandler(deps);

    const outcome = await handler(
      { ...ENVELOPE, jobType: "shopee.items.hydrate" },
      { logger: createLogger({}, { sink: (line) => lines.push(line) }), payload: { shopeeShopId: LOJA_ID } },
    );

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(lines.join("\n")).toContain("shopee_items_hydrate_enqueue_failed");
  });
});
