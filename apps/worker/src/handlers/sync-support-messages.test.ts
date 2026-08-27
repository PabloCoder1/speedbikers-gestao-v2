import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { persistSupportConversation } from "./persist-support-conversation.js";
import type { SyncSupportMessagesDeps } from "./sync-support-messages.js";
import { createSyncSupportMessagesHandler } from "./sync-support-messages.js";

type PersistSupportConversation = typeof persistSupportConversation;

const persistMock = vi.hoisted(() => vi.fn<PersistSupportConversation>());

vi.mock("./persist-support-conversation.js", () => ({
  persistSupportConversation: persistMock,
}));

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "22222222-0000-4000-8000-000000000002";
const SELLER_ID = 419_059_118;
const PACK_ID = "2000000089077943";
const MESSAGE_ID = "fd1d2e37ad004ede9e0bf25d1215002d";
const NOW = new Date("2026-08-26T19:00:00.000Z");
const ENCRYPTION_KEY = randomBytes(32);

const OAUTH_CONFIG = { clientId: "APP_ID_123", clientSecret: "segredo-de-teste", redirectUri: "" };

const ENVELOPE = {
  jobType: "sync.support.messages",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b21",
  organizationId: ORGANIZATION_ID,
  dedupeKey: `ml-webhook:${MESSAGE_ID}:2026-08-26T19:00`,
  attempt: 1,
  enqueuedAt: NOW.toISOString(),
};

function conversation(messages: unknown[], total?: number): unknown {
  return {
    paging: { limit: 100, offset: 0, total: total ?? messages.length },
    conversation_status: {
      path: `/packs/${PACK_ID}/seller/${String(SELLER_ID)}`,
      status: "active",
      substatus: null,
      status_date: "2026-08-26T18:00:00.000Z",
    },
    messages,
    seller_max_message_length: 350,
  };
}

function buyerMessage(id: string): unknown {
  return {
    id,
    site_id: "MLB",
    from: { user_id: 777 },
    to: { user_id: SELLER_ID },
    status: "available",
    text: "quando chega?",
    message_date: { created: "2026-08-26T18:00:00.000Z" },
    message_resources: [
      { id: PACK_ID, name: "packs" },
      { id: String(SELLER_ID), name: "sellers" },
    ],
  };
}

const MESSAGE_DETAIL = {
  message_id: MESSAGE_ID,
  resource: "packs",
  resource_id: PACK_ID,
};

function chain<T>(result: T) {
  const self = { eq: () => self, maybeSingle: () => Promise.resolve(result) };
  return self;
}

interface FakeDbOptions {
  account?: { organization_id: string; seller_id: number | null; status: string } | null;
}

const DEFAULT_ACCOUNT = {
  organization_id: ORGANIZATION_ID,
  seller_id: SELLER_ID,
  status: "CONNECTED",
};

function fakeDb(options: FakeDbOptions = {}): SyncSupportMessagesDeps["db"] {
  const account = "account" in options ? options.account : DEFAULT_ACCOUNT;

  return {
    from: (table: string) => ({
      select: () => {
        if (table === "ml_accounts") {
          return chain({ data: account ?? null, error: null });
        }

        if (table === "ml_credentials") {
          return chain({
            data: {
              access_token_ciphertext: encryptToken("APP_USR-valido", ENCRYPTION_KEY),
              refresh_token_ciphertext: encryptToken("TG-valido", ENCRYPTION_KEY),
              access_token_expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
            },
            error: null,
          });
        }

        throw new Error(`select inesperado em ${table}`);
      },
    }),
  } as unknown as SyncSupportMessagesDeps["db"];
}

interface RecordedRequest {
  path: string;
  searchParams: RequestOptions<unknown>["searchParams"];
}

/** Responde por caminho: `/messages/{id}` é detalhe, `/messages/packs/...` é conversa. */
function fakeClient(
  responses: { detail?: unknown; pages?: unknown[]; failWith?: Error } = {},
): { client: MercadoLivreClient; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  let pageIndex = 0;

  const request = <T>(options: RequestOptions<T>): Promise<T> => {
    requests.push({ path: options.path, searchParams: options.searchParams });

    if (responses.failWith !== undefined) {
      return Promise.reject(responses.failWith);
    }

    const value = options.path.startsWith("/messages/packs/")
      ? (responses.pages?.[pageIndex++] ?? conversation([buyerMessage(MESSAGE_ID)]))
      : (responses.detail ?? MESSAGE_DETAIL);

    return Promise.resolve().then(() => options.schema.parse(value));
  };

  return { client: { request }, requests };
}

function setup(dbOptions: FakeDbOptions = {}, responses: Parameters<typeof fakeClient>[0] = {}) {
  const { client, requests } = fakeClient(responses);
  const lines: string[] = [];

  return {
    deps: {
      db: fakeDb(dbOptions),
      mercadoLivre: client,
      oauth: OAUTH_CONFIG,
      encryptionKey: ENCRYPTION_KEY,
      now: () => NOW,
    } satisfies SyncSupportMessagesDeps,
    requests,
    lines,
  };
}

function run(
  deps: SyncSupportMessagesDeps,
  lines: string[],
  payload: unknown = { mlAccountId: ML_ACCOUNT_ID, packOrOrderId: PACK_ID, kind: "PACK" },
  envelope = ENVELOPE,
) {
  return createSyncSupportMessagesHandler(deps)(envelope, {
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    payload,
  });
}

describe("sync.support.messages", () => {
  beforeEach(() => {
    persistMock.mockReset();
    persistMock.mockResolvedValue({
      supportCaseId: "case-1",
      messagesUpserted: 1,
      linkedOrderIds: [1],
      linkMode: "TYPED",
        transitionApplied: false,
    });
  });

  it("recusa payload sem packOrOrderId nem messageId, sem retry", async () => {
    const ctx = setup();

    await expect(run(ctx.deps, ctx.lines, { mlAccountId: ML_ACCOUNT_ID })).resolves.toMatchObject({
      status: "failed",
      retryable: false,
    });
  });

  it("recusa conta de outra organização, sem retry", async () => {
    const ctx = setup({ account: { ...DEFAULT_ACCOUNT, organization_id: OTHER_ORGANIZATION_ID } });

    await expect(run(ctx.deps, ctx.lines)).resolves.toMatchObject({
      status: "failed",
      retryable: false,
      reason: "mlAccountId não pertence à organizationId do job",
    });
    expect(persistMock).not.toHaveBeenCalled();
  });

  it("conta desconectada encerra sem tocar no Mercado Livre", async () => {
    const ctx = setup({ account: { ...DEFAULT_ACCOUNT, status: "REVOKED" } });

    await expect(run(ctx.deps, ctx.lines)).resolves.toEqual({ status: "done", processed: 0 });
    expect(ctx.requests).toHaveLength(0);
  });

  it("lê a conversa com mark_as_read=false — um sync não marca como lida (D-083)", async () => {
    const ctx = setup();

    await expect(run(ctx.deps, ctx.lines)).resolves.toMatchObject({ status: "done" });
    expect(ctx.requests[0]?.path).toBe(`/messages/packs/${PACK_ID}/sellers/${String(SELLER_ID)}`);
    expect(ctx.requests[0]?.searchParams).toMatchObject({ mark_as_read: false, tag: "post_sale" });
  });

  it("pelo webhook, resolve a mensagem para a conversa ANTES de ler o transcript", async () => {
    const ctx = setup();

    await expect(
      run(ctx.deps, ctx.lines, { mlAccountId: ML_ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).resolves.toMatchObject({ status: "done" });

    expect(ctx.requests[0]?.path).toBe(`/messages/${MESSAGE_ID}`);
    expect(ctx.requests[1]?.path).toBe(`/messages/packs/${PACK_ID}/sellers/${String(SELLER_ID)}`);
  });

  it("mensagem sem pack/pedido não vira retry infinito — encerra e registra", async () => {
    const ctx = setup({}, { detail: { message_id: MESSAGE_ID, resource: null, resource_id: null } });

    await expect(
      run(ctx.deps, ctx.lines, { mlAccountId: ML_ACCOUNT_ID, messageId: MESSAGE_ID }),
    ).resolves.toEqual({ status: "done", processed: 0 });
    expect(ctx.lines.join("\n")).toContain("sync_support_messages_unlocatable");
    expect(persistMock).not.toHaveBeenCalled();
  });

  it("pagina até cobrir o total remoto, sem parar na primeira página", async () => {
    const ctx = setup(
      {},
      {
        pages: [
          conversation(
            Array.from({ length: 100 }, (_, index) => buyerMessage(`m${String(index)}`)),
            150,
          ),
          conversation(
            Array.from({ length: 50 }, (_, index) => buyerMessage(`n${String(index)}`)),
            150,
          ),
        ],
      },
    );

    await run(ctx.deps, ctx.lines);

    expect(ctx.requests).toHaveLength(2);
    expect(ctx.requests[1]?.searchParams).toMatchObject({ offset: 100 });
    expect(persistMock.mock.calls[0]?.[2].messages).toHaveLength(150);
  });

  it("para de paginar quando a página volta vazia, mesmo com total maior", async () => {
    const ctx = setup(
      {},
      { pages: [conversation([buyerMessage("m1")], 500), conversation([], 500)] },
    );

    await run(ctx.deps, ctx.lines);

    expect(ctx.requests).toHaveLength(2);
    expect(persistMock.mock.calls[0]?.[2].messages).toHaveLength(1);
  });

  it("descobre pack/order pelo payload remoto quando o produtor não sabe", async () => {
    const ctx = setup();

    await run(ctx.deps, ctx.lines, { mlAccountId: ML_ACCOUNT_ID, packOrOrderId: PACK_ID });

    expect(persistMock.mock.calls[0]?.[2].case.externalCaseKey).toBe(`message:pack:${PACK_ID}`);
  });

  it("propaga a classe de erro do Mercado Livre em vez de assumir retry", async () => {
    const ctx = setup(
      {},
      {
        failWith: new MercadoLivreApiError("blocked_conversation_send_message_forbidden", {
          status: 403,
          errorClass: "not_retryable",
          url: "https://api.mercadolibre.com/messages/packs/1/sellers/2",
          body: null,
        }),
      },
    );

    await expect(run(ctx.deps, ctx.lines)).resolves.toMatchObject({
      status: "failed",
      retryable: false,
    });
  });

  it("payload fora do contrato não é retentado: repetir daria o mesmo erro", async () => {
    const ctx = setup({}, { pages: [{ messages: [{ id: "m1", from: { user_id: "xyz" } }] }] });

    await expect(run(ctx.deps, ctx.lines)).resolves.toMatchObject({
      status: "failed",
      retryable: false,
    });
  });

  it("falha de persistência é retentável — a próxima entrega converge pelos UPSERTs", async () => {
    const ctx = setup();
    persistMock.mockRejectedValueOnce(new Error("banco indisponível"));

    await expect(run(ctx.deps, ctx.lines)).resolves.toMatchObject({
      status: "failed",
      retryable: true,
    });
  });

  it("nunca registra o texto da mensagem no log", async () => {
    const ctx = setup();

    await run(ctx.deps, ctx.lines);

    expect(ctx.lines.join("\n")).toContain("sync_support_messages_done");
    expect(ctx.lines.join("\n")).not.toContain("quando chega?");
  });

  it("repassa a contagem de não lidas que a reconciliação conhece", async () => {
    const ctx = setup();

    await run(ctx.deps, ctx.lines, {
      mlAccountId: ML_ACCOUNT_ID,
      packOrOrderId: PACK_ID,
      kind: "PACK",
      unreadCount: 4,
    });

    expect(persistMock.mock.calls[0]?.[2].case.remoteUnreadCount).toBe(4);
  });
});
