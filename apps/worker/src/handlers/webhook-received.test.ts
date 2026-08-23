import { randomBytes } from "node:crypto";

import { encryptToken, MercadoLivreApiError } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { WebhookReceivedDeps } from "./webhook-received.js";
import { createWebhookReceivedHandler } from "./webhook-received.js";

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ENCRYPTION_KEY = randomBytes(32);
const NOW = new Date("2026-08-22T15:37:00.000Z");

const OAUTH_CONFIG = { clientId: "APP_ID_123", clientSecret: "segredo-de-teste", redirectUri: "" };

const ENVELOPE = {
  jobType: "sync.webhook.received",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
  organizationId: ORGANIZATION_ID,
  dedupeKey: "ml-webhook:/orders/2000003508426396:2026-08-22T15:37",
  attempt: 1,
  enqueuedAt: "2026-08-22T15:37:00.000Z",
};

const PAYLOAD = { mlAccountId: ML_ACCOUNT_ID, resource: "/orders/2000003508426396", topic: "orders_v2" };

/** Fake mínimo, encadeável e thenable — mesmo espírito de `sync-orders-window.test.ts`. */
function chain<T>(result: T): {
  eq: () => ReturnType<typeof chain<T>>;
  or: () => ReturnType<typeof chain<T>>;
  is: () => ReturnType<typeof chain<T>>;
  maybeSingle: () => Promise<T>;
} {
  const self = {
    eq: () => self,
    or: () => self,
    is: () => self,
    maybeSingle: () => Promise.resolve(result),
  };

  return self;
}

interface FakeDbOptions {
  account?: { organization_id: string; status: string } | null;
  credentials?: {
    access_token_ciphertext: string;
    refresh_token_ciphertext: string;
    access_token_expires_at: string;
  } | null;
}

const DEFAULT_ACCOUNT = { organization_id: ORGANIZATION_ID, status: "CONNECTED" };

function validCredentials(): FakeDbOptions["credentials"] {
  return {
    access_token_ciphertext: encryptToken("APP_USR-valido", ENCRYPTION_KEY),
    refresh_token_ciphertext: encryptToken("TG-valido", ENCRYPTION_KEY),
    access_token_expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
  };
}

function fakeDb(options: FakeDbOptions = {}): WebhookReceivedDeps["db"] {
  const account = "account" in options ? options.account : DEFAULT_ACCOUNT;
  const credentials = "credentials" in options ? options.credentials : validCredentials();

  return {
    from: (table: string) => ({
      select: () => {
        if (table === "ml_accounts") {
          return chain({ data: account ?? null, error: null });
        }

        if (table === "ml_credentials") {
          return chain({ data: credentials ?? null, error: null });
        }

        // sku_listing_links: sem vínculo cadastrado no fake — persistOrder grava sku_id nulo.
        return chain({ data: null, error: null });
      },
      update: () => chain({ data: { ml_account_id: ML_ACCOUNT_ID }, error: null }),
      // persistOrder: upsert de `orders`, delete + insert de `order_items`,
      // insert de `stock_movements`/`domain_events` (dedução por venda).
      upsert: () => Promise.resolve({ data: null, error: null }),
      insert: () => Promise.resolve({ data: null, error: null }),
      delete: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
    }),
  } as unknown as WebhookReceivedDeps["db"];
}

/** Order mínima, mas válida contra `orderSchema` — o que `GET /orders/{id}` devolve de verdade. */
const FAKE_ORDER = {
  id: 2000003508426396,
  status: "paid",
  date_created: "2026-08-22T15:30:00.000Z",
  date_last_updated: "2026-08-22T15:36:00.000Z",
  total_amount: 100,
  currency_id: "BRL",
  order_items: [{ item: { id: "MLB1", title: "Item" }, quantity: 1, unit_price: 100, currency_id: "BRL" }],
};

function fakeMercadoLivreClient(
  behavior: Record<string, unknown> | (() => Promise<never>),
): { client: MercadoLivreClient; requests: RequestOptions<unknown>[] } {
  const requests: RequestOptions<unknown>[] = [];

  const client = {
    request: (options: RequestOptions<unknown>) => {
      requests.push(options);

      return typeof behavior === "function" ? behavior() : Promise.resolve(behavior);
    },
  } as unknown as MercadoLivreClient;

  return { client, requests };
}

function deps(
  dbOptions: FakeDbOptions,
  orderResponse: Record<string, unknown> | (() => Promise<never>) = FAKE_ORDER,
): { deps: WebhookReceivedDeps; requests: RequestOptions<unknown>[]; lines: string[] } {
  const { client, requests } = fakeMercadoLivreClient(orderResponse);
  const lines: string[] = [];

  return {
    requests,
    lines,
    deps: {
      db: fakeDb(dbOptions),
      mercadoLivre: client,
      oauth: OAUTH_CONFIG,
      encryptionKey: ENCRYPTION_KEY,
      now: () => NOW,
    },
  };
}

function run(d: WebhookReceivedDeps, lines: string[], payload: unknown = PAYLOAD) {
  const handler = createWebhookReceivedHandler(d);

  return handler(ENVELOPE, { logger: createLogger({}, { sink: (line) => lines.push(line) }), payload });
}

describe("sync.webhook.received — Fast Path", () => {
  it("busca o pedido único e persiste — caminho feliz", async () => {
    const { deps: d, requests, lines } = deps({});

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(requests).toEqual([
      expect.objectContaining({ method: "GET", path: "/orders/2000003508426396" }),
    ]);
  });

  it("payload sem mlAccountId/resource/topic falha sem retry", async () => {
    const { deps: d, lines } = deps({});

    const outcome = await run(d, lines, {});

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });

  it("tópico diferente de orders_v2 é ACK sem trabalho — sem consumidor ainda", async () => {
    const { deps: d, requests, lines } = deps({});

    const outcome = await run(d, lines, { ...PAYLOAD, topic: "items" });

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(requests).toHaveLength(0);
  });

  it("resource fora do formato /orders/{id} falha sem retry", async () => {
    const { deps: d, lines } = deps({});

    const outcome = await run(d, lines, { ...PAYLOAD, resource: "/items/MLB123" });

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });

  it("conta inexistente: done sem processar — corrida benigna, não erro", async () => {
    const { deps: d, requests, lines } = deps({ account: null });

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(requests).toHaveLength(0);
  });

  it("conta não CONNECTED: done sem processar", async () => {
    const { deps: d, requests, lines } = deps({ account: { organization_id: ORGANIZATION_ID, status: "ERROR" } });

    const outcome = await run(d, lines);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(requests).toHaveLength(0);
  });

  it("sem credenciais gravadas: falha sem retry", async () => {
    const { deps: d, lines } = deps({ credentials: null });

    const outcome = await run(d, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });

  it("falha retryable do Mercado Livre propaga como retryable", async () => {
    const { deps: d, lines } = deps({}, () =>
      Promise.reject(new MercadoLivreApiError("instabilidade", { status: 503, errorClass: "retryable", url: "x" })),
    );

    const outcome = await run(d, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("falha not_retryable do Mercado Livre (ex.: pedido não encontrado) não repete", async () => {
    const { deps: d, lines } = deps({}, () =>
      Promise.reject(
        new MercadoLivreApiError("não encontrado", { status: 404, errorClass: "not_retryable", url: "x" }),
      ),
    );

    const outcome = await run(d, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });

  describe("post_purchase (D-057) — só o roteamento; o processamento em si é testado em claim-return.test.ts", () => {
    const POST_PURCHASE_PAYLOAD = {
      mlAccountId: ML_ACCOUNT_ID,
      resource: "/post-purchase/v1/claims/5298178312",
      topic: "post_purchase",
    };

    it("resource fora do formato /post-purchase/v1/claims/{id} falha sem retry", async () => {
      const { deps: d, lines } = deps({});

      const outcome = await run(d, lines, { ...POST_PURCHASE_PAYLOAD, resource: "/post-purchase/v1/other/1" });

      expect(outcome).toMatchObject({ status: "failed", retryable: false });
    });

    it("busca o claim certo — claim sem devolução associada processa zero", async () => {
      const { deps: d, requests, lines } = deps(
        {},
        { id: 5298312, resource: "order", resource_id: 1, status: "closed", type: "mediations", related_entities: [] },
      );

      const outcome = await run(d, lines, POST_PURCHASE_PAYLOAD);

      expect(outcome).toEqual({ status: "done", processed: 0 });
      expect(requests).toEqual([
        expect.objectContaining({ method: "GET", path: "/post-purchase/v1/claims/5298178312" }),
      ]);
    });
  });
});
