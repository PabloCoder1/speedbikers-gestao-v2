import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { persistSupportConversation } from "./persist-support-conversation.js";
import type { recordSyncRunFailure, recordSyncRunSuccess } from "./sync-runs.js";

const persistMock = vi.hoisted(() => vi.fn<typeof persistSupportConversation>());
const recordSyncRunSuccessMock = vi.hoisted(() => vi.fn<typeof recordSyncRunSuccess>());
const recordSyncRunFailureMock = vi.hoisted(() => vi.fn<typeof recordSyncRunFailure>());

vi.mock("./persist-support-conversation.js", () => ({
  persistSupportConversation: persistMock,
}));

vi.mock("./sync-runs.js", () => ({
  recordSyncRunSuccess: recordSyncRunSuccessMock,
  recordSyncRunFailure: recordSyncRunFailureMock,
}));

const { createSyncSupportMessagesReconcileHandler } = await import(
  "./sync-support-messages-reconcile.js"
);

type Deps = Parameters<typeof createSyncSupportMessagesReconcileHandler>[0];

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const SELLER_ID = 419_059_118;
const NOW = new Date("2026-08-26T19:00:00.000Z");
const ENCRYPTION_KEY = randomBytes(32);

const OAUTH_CONFIG = { clientId: "APP_ID_123", clientSecret: "segredo-de-teste", redirectUri: "" };

const ENVELOPE = {
  jobType: "sync.support.messages.reconcile",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b41",
  organizationId: ORGANIZATION_ID,
  dedupeKey: "support-messages:loja:2026-08-26T19:00",
  attempt: 1,
  enqueuedAt: NOW.toISOString(),
};

const DEFAULT_ACCOUNT = {
  id: ML_ACCOUNT_ID,
  organization_id: ORGANIZATION_ID,
  seller_id: SELLER_ID,
  status: "CONNECTED",
};

function unread(resources: { resource: string; count: number }[]): unknown {
  return { user_id: SELLER_ID, results: resources };
}

function conversation(): unknown {
  return {
    paging: { limit: 100, offset: 0, total: 1 },
    conversation_status: { status: "active", status_date: "2026-08-26T18:00:00.000Z" },
    messages: [
      {
        id: "m1",
        from: { user_id: 777 },
        to: { user_id: SELLER_ID },
        status: "available",
        text: "cadê meu pedido?",
        message_date: { created: "2026-08-26T18:00:00.000Z" },
        message_resources: [{ id: "1977056109", name: "packs" }],
      },
    ],
  };
}

function chain<T>(result: T) {
  const self = { eq: () => self, maybeSingle: () => Promise.resolve(result) };
  return self;
}

function fakeDb(account: typeof DEFAULT_ACCOUNT | null = DEFAULT_ACCOUNT): Deps["db"] {
  return {
    from: (table: string) => ({
      select: () => {
        if (table === "ml_accounts") {
          return chain({ data: account, error: null });
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
  } as unknown as Deps["db"];
}

interface ClientOptions {
  unreadPayload?: unknown;
  unreadError?: Error;
  conversationError?: Error;
}

function fakeClient(options: ClientOptions = {}): {
  client: MercadoLivreClient;
  paths: string[];
} {
  const paths: string[] = [];
  const request = <T>(requestOptions: RequestOptions<T>): Promise<T> => {
    paths.push(requestOptions.path);

    if (requestOptions.path === "/messages/unread") {
      if (options.unreadError !== undefined) {
        return Promise.reject(options.unreadError);
      }

      return Promise.resolve().then(() =>
        requestOptions.schema.parse(
          options.unreadPayload ??
            unread([{ resource: `/packs/1977056109/sellers/${String(SELLER_ID)}`, count: 1 }]),
        ),
      );
    }

    if (options.conversationError !== undefined) {
      return Promise.reject(options.conversationError);
    }

    return Promise.resolve().then(() => requestOptions.schema.parse(conversation()));
  };

  return { client: { request }, paths };
}

function setup(
  account: typeof DEFAULT_ACCOUNT | null = DEFAULT_ACCOUNT,
  clientOptions: ClientOptions = {},
) {
  const { client, paths } = fakeClient(clientOptions);
  const lines: string[] = [];

  return {
    deps: {
      db: fakeDb(account),
      mercadoLivre: client,
      oauth: OAUTH_CONFIG,
      encryptionKey: ENCRYPTION_KEY,
      now: () => NOW,
    } satisfies Deps,
    paths,
    lines,
  };
}

function run(deps: Deps, lines: string[], payload: unknown = { mlAccountId: ML_ACCOUNT_ID }) {
  return createSyncSupportMessagesReconcileHandler(deps)(ENVELOPE, {
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    payload,
  });
}

describe("sync.support.messages.reconcile", () => {
  beforeEach(() => {
    persistMock.mockReset();
    recordSyncRunSuccessMock.mockReset();
    recordSyncRunFailureMock.mockReset();
    persistMock.mockResolvedValue({
      supportCaseId: "case-1",
      messagesUpserted: 1,
      linkedOrderIds: [],
      linkMode: "EXTERNAL",
    });
  });

  it("varre as não lidas com role=seller e persiste cada conversa", async () => {
    const ctx = setup();

    await expect(run(ctx.deps, ctx.lines)).resolves.toEqual({ status: "done", processed: 1 });
    expect(ctx.paths[0]).toBe("/messages/unread");
    expect(ctx.paths[1]).toBe(`/messages/packs/1977056109/sellers/${String(SELLER_ID)}`);
    expect(recordSyncRunSuccessMock.mock.calls[0]?.[1]).toMatchObject({
      resource: "messages",
      channel: "reconciliation",
      itemsProcessed: 1,
      status: "done",
    });
  });

  it("repassa a contagem de não lidas para o case", async () => {
    const ctx = setup(DEFAULT_ACCOUNT, {
      unreadPayload: unread([
        { resource: `/packs/1977056109/sellers/${String(SELLER_ID)}`, count: 7 },
      ]),
    });

    await run(ctx.deps, ctx.lines);

    expect(persistMock.mock.calls[0]?.[2].case.remoteUnreadCount).toBe(7);
  });

  it("nenhuma não lida encerra sem GET de conversa e ainda registra a execução", async () => {
    const ctx = setup(DEFAULT_ACCOUNT, { unreadPayload: unread([]) });

    await expect(run(ctx.deps, ctx.lines)).resolves.toEqual({ status: "done", processed: 0 });
    expect(ctx.paths).toEqual(["/messages/unread"]);
    expect(recordSyncRunSuccessMock.mock.calls[0]?.[1]).toMatchObject({ status: "done" });
  });

  it("uma conversa que falha não derruba as outras — resultado vira parcial", async () => {
    const ctx = setup(DEFAULT_ACCOUNT, {
      unreadPayload: unread([
        { resource: `/packs/1/sellers/${String(SELLER_ID)}`, count: 1 },
        { resource: `/packs/2/sellers/${String(SELLER_ID)}`, count: 1 },
      ]),
    });
    persistMock.mockRejectedValueOnce(new Error("conversa bloqueada"));

    await expect(run(ctx.deps, ctx.lines)).resolves.toEqual({ status: "done", processed: 1 });
    expect(recordSyncRunSuccessMock.mock.calls[0]?.[1]).toMatchObject({
      status: "partial",
      itemsProcessed: 1,
    });
    expect(recordSyncRunSuccessMock.mock.calls[0]?.[1].reason).toContain("1 conversa(s) falharam");
  });

  it("resource ilegível é registrado como parcial em vez de derrubar a varredura", async () => {
    const ctx = setup(DEFAULT_ACCOUNT, {
      unreadPayload: unread([{ resource: "/claims/123", count: 1 }]),
    });

    await expect(run(ctx.deps, ctx.lines)).resolves.toEqual({ status: "done", processed: 0 });
    expect(recordSyncRunSuccessMock.mock.calls[0]?.[1].reason).toContain("fora do formato esperado");
    expect(persistMock).not.toHaveBeenCalled();
  });

  it("recusa conversa de outro vendedor mesmo vindo da lista da conta", async () => {
    const ctx = setup(DEFAULT_ACCOUNT, {
      unreadPayload: unread([{ resource: "/packs/1977056109/sellers/999999", count: 1 }]),
    });

    await expect(run(ctx.deps, ctx.lines)).resolves.toEqual({ status: "done", processed: 0 });
    expect(recordSyncRunSuccessMock.mock.calls[0]?.[1].reason).toContain("seller_id divergente");
  });

  it("trunca no teto de conversas e diz que truncou, em vez de fingir cobertura", async () => {
    const ctx = setup(DEFAULT_ACCOUNT, {
      unreadPayload: unread(
        Array.from({ length: 130 }, (_, index) => ({
          resource: `/packs/${String(index + 1)}/sellers/${String(SELLER_ID)}`,
          count: 1,
        })),
      ),
    });

    await expect(run(ctx.deps, ctx.lines)).resolves.toEqual({ status: "done", processed: 120 });
    expect(recordSyncRunSuccessMock.mock.calls[0]?.[1]).toMatchObject({ status: "partial" });
    expect(recordSyncRunSuccessMock.mock.calls[0]?.[1].reason).toContain("truncada no teto de 120");
  });

  it("falha ao listar não lidas vira sync_run de FALHA, não sucesso vazio", async () => {
    const ctx = setup(DEFAULT_ACCOUNT, {
      unreadError: new MercadoLivreApiError("rate limit", {
        status: 429,
        errorClass: "retryable",
        url: "https://api.mercadolibre.com/messages/unread",
        body: null,
      }),
    });

    await expect(run(ctx.deps, ctx.lines)).resolves.toMatchObject({
      status: "failed",
      retryable: true,
    });
    expect(recordSyncRunFailureMock).toHaveBeenCalledTimes(1);
    expect(recordSyncRunSuccessMock).not.toHaveBeenCalled();
  });

  it("conta de outra organização é recusada sem retry", async () => {
    const ctx = setup({ ...DEFAULT_ACCOUNT, organization_id: "22222222-0000-4000-8000-000000000002" });

    await expect(run(ctx.deps, ctx.lines)).resolves.toMatchObject({
      status: "failed",
      retryable: false,
    });
    expect(ctx.paths).toHaveLength(0);
  });

  it("nunca registra o texto da mensagem no log", async () => {
    const ctx = setup();

    await run(ctx.deps, ctx.lines);

    expect(ctx.lines.join("\n")).toContain("sync_support_messages_reconcile_done");
    expect(ctx.lines.join("\n")).not.toContain("cadê meu pedido?");
  });
});
