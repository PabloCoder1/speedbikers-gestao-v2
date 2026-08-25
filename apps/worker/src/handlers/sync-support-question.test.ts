import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { persistSupportQuestion } from "./persist-support-question.js";
import type { SyncSupportQuestionDeps } from "./sync-support-question.js";
import { createSyncSupportQuestionHandler } from "./sync-support-question.js";

type PersistSupportQuestion = typeof persistSupportQuestion;

const persistSupportQuestionMock = vi.hoisted(() => vi.fn<PersistSupportQuestion>());

vi.mock("./persist-support-question.js", () => ({
  persistSupportQuestion: persistSupportQuestionMock,
}));

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "22222222-0000-4000-8000-000000000002";
const QUESTION_ID = 11_436_370_259;
const SELLER_ID = 419_059_118;
const NOW = new Date("2026-08-25T19:00:00.000Z");
const ENCRYPTION_KEY = randomBytes(32);

const OAUTH_CONFIG = {
  clientId: "APP_ID_123",
  clientSecret: "segredo-de-teste",
  redirectUri: "",
};

const ENVELOPE = {
  jobType: "sync.support.questions",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b21",
  organizationId: ORGANIZATION_ID,
  dedupeKey: `support-question:${ML_ACCOUNT_ID}:${String(QUESTION_ID)}`,
  attempt: 1,
  enqueuedAt: NOW.toISOString(),
};

const QUESTION = {
  id: QUESTION_ID,
  seller_id: SELLER_ID,
  buyer_id: 419_067_349,
  item_id: "MLB1623490410",
  status: "UNANSWERED",
  text: "O produto ainda está disponível?",
  date_created: "2020-08-20T13:22:01.600-04:00",
  answer: null,
};

function chain<T>(result: T) {
  const self = {
    eq: () => self,
    maybeSingle: () => Promise.resolve(result),
  };

  return self;
}

interface FakeDbOptions {
  account?: {
    organization_id: string;
    seller_id: number | null;
    status: string;
  } | null;
  accountError?: { message: string } | null;
  credentials?: {
    access_token_ciphertext: string;
    refresh_token_ciphertext: string;
    access_token_expires_at: string;
  } | null;
}

const DEFAULT_ACCOUNT = {
  organization_id: ORGANIZATION_ID,
  seller_id: SELLER_ID,
  status: "CONNECTED",
};

function validCredentials(): NonNullable<FakeDbOptions["credentials"]> {
  return {
    access_token_ciphertext: encryptToken("APP_USR-valido", ENCRYPTION_KEY),
    refresh_token_ciphertext: encryptToken("TG-valido", ENCRYPTION_KEY),
    access_token_expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
  };
}

function fakeDb(options: FakeDbOptions = {}): SyncSupportQuestionDeps["db"] {
  const account = "account" in options ? options.account : DEFAULT_ACCOUNT;
  const credentials = "credentials" in options ? options.credentials : validCredentials();

  return {
    from: (table: string) => ({
      select: () => {
        if (table === "ml_accounts") {
          return chain({
            data: account ?? null,
            error: options.accountError ?? null,
          });
        }

        if (table === "ml_credentials") {
          return chain({ data: credentials ?? null, error: null });
        }

        throw new Error(`select inesperado em ${table}`);
      },
    }),
  } as unknown as SyncSupportQuestionDeps["db"];
}

type RemoteBehavior =
  | { kind: "response"; value: unknown }
  | { error: Error; kind: "failure" };

interface RecordedRequest {
  accessToken: string | undefined;
  method: RequestOptions<unknown>["method"];
  path: string;
  searchParams: RequestOptions<unknown>["searchParams"];
}

function fakeMercadoLivreClient(
  behavior: RemoteBehavior = { kind: "response", value: QUESTION },
): {
  client: MercadoLivreClient;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const request = <T>(options: RequestOptions<T>): Promise<T> => {
    requests.push({
      accessToken: options.accessToken,
      method: options.method,
      path: options.path,
      searchParams: options.searchParams,
    });

    if (behavior.kind === "failure") {
      return Promise.reject(behavior.error);
    }

    return Promise.resolve().then(() => options.schema.parse(behavior.value));
  };
  const client: MercadoLivreClient = { request };

  return { client, requests };
}

function setup(
  dbOptions: FakeDbOptions = {},
  remoteBehavior: RemoteBehavior = { kind: "response", value: QUESTION },
): {
  deps: SyncSupportQuestionDeps;
  requests: RecordedRequest[];
  lines: string[];
} {
  const { client, requests } = fakeMercadoLivreClient(remoteBehavior);
  const lines: string[] = [];

  return {
    deps: {
      db: fakeDb(dbOptions),
      mercadoLivre: client,
      oauth: OAUTH_CONFIG,
      encryptionKey: ENCRYPTION_KEY,
      now: () => NOW,
    },
    requests,
    lines,
  };
}

function run(
  deps: SyncSupportQuestionDeps,
  lines: string[],
  payload: unknown = { mlAccountId: ML_ACCOUNT_ID, questionId: QUESTION_ID },
  envelope = ENVELOPE,
) {
  return createSyncSupportQuestionHandler(deps)(envelope, {
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    payload,
  });
}

describe("sync.support.questions", () => {
  beforeEach(() => {
    persistSupportQuestionMock.mockReset();
    persistSupportQuestionMock.mockResolvedValue({
      supportCaseId: "case-1",
      messagesUpserted: 1,
      linkMode: "EXTERNAL",
    });
  });

  it("busca uma pergunta v4, mapeia e persiste no escopo da conta", async () => {
    const { deps, requests, lines } = setup();

    const outcome = await run(deps, lines);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(requests).toEqual([
      expect.objectContaining({
        method: "GET",
        path: `/questions/${String(QUESTION_ID)}`,
        searchParams: { api_version: 4 },
        accessToken: "APP_USR-valido",
      }),
    ]);
    expect(persistSupportQuestionMock).toHaveBeenCalledTimes(1);
    const call = persistSupportQuestionMock.mock.calls[0];
    expect(call?.[0]).toBe(deps.db);
    expect(call?.[1]).toEqual({ organizationId: ORGANIZATION_ID, mlAccountId: ML_ACCOUNT_ID });
    expect(call?.[2].case.externalCaseKey).toBe(`question:${String(QUESTION_ID)}`);
    expect(call?.[2].case.externalStatus).toBe("UNANSWERED");
    expect(lines.join("\n")).not.toContain("APP_USR-valido");
  });

  it("payload inválido falha sem retry e sem rede", async () => {
    const { deps, requests, lines } = setup();

    const outcome = await run(deps, lines, { mlAccountId: ML_ACCOUNT_ID, questionId: -1 });

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(requests).toHaveLength(0);
  });

  it("falha de leitura da conta é retryable, não se confunde com conta ausente", async () => {
    const { deps, requests, lines } = setup({ accountError: { message: "database unavailable" } });

    const outcome = await run(deps, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(requests).toHaveLength(0);
  });

  it("conta inexistente conclui sem trabalho", async () => {
    const { deps, requests, lines } = setup({ account: null });

    expect(await run(deps, lines)).toEqual({ status: "done", processed: 0 });
    expect(requests).toHaveLength(0);
  });

  it("recusa mlAccountId de outra organização do envelope", async () => {
    const { deps, requests, lines } = setup({
      account: { ...DEFAULT_ACCOUNT, organization_id: OTHER_ORGANIZATION_ID },
    });

    const outcome = await run(deps, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(requests).toHaveLength(0);
  });

  it("conta desconectada conclui sem buscar a pergunta", async () => {
    const { deps, requests, lines } = setup({
      account: { ...DEFAULT_ACCOUNT, status: "REVOKED" },
    });

    expect(await run(deps, lines)).toEqual({ status: "done", processed: 0 });
    expect(requests).toHaveLength(0);
  });

  it("conta CONNECTED sem seller_id falha sem retry", async () => {
    const { deps, requests, lines } = setup({
      account: { ...DEFAULT_ACCOUNT, seller_id: null },
    });

    const outcome = await run(deps, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(requests).toHaveLength(0);
  });

  it("conta CONNECTED sem credenciais falha sem retry", async () => {
    const { deps, requests, lines } = setup({ credentials: null });

    const outcome = await run(deps, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(requests).toHaveLength(0);
  });

  it.each([
    ["retryable", true],
    ["not_retryable", false],
  ] as const)("propaga erro remoto %s com retryable=%s", async (errorClass, retryable) => {
    const remoteError = new MercadoLivreApiError("falha remota", {
      status: retryable ? 503 : 404,
      errorClass,
      url: "https://api.mercadolibre.com/questions/id",
    });
    const { deps, lines } = setup({}, { error: remoteError, kind: "failure" });

    const outcome = await run(deps, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable });
    expect(persistSupportQuestionMock).not.toHaveBeenCalled();
  });

  it("payload remoto fora do contrato falha sem retry e sem persistir", async () => {
    const { deps, lines } = setup({}, {
      kind: "response",
      value: { ...QUESTION, status: "PENDING" },
    });

    const outcome = await run(deps, lines);

    expect(outcome).toEqual({
      status: "failed",
      retryable: false,
      reason: "resposta de pergunta fora do contrato esperado",
    });
    expect(persistSupportQuestionMock).not.toHaveBeenCalled();
  });

  it("recusa pergunta pertencente a outro seller antes da persistência", async () => {
    const { deps, lines } = setup({}, {
      kind: "response",
      value: { ...QUESTION, seller_id: SELLER_ID + 1 },
    });

    const outcome = await run(deps, lines);

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(persistSupportQuestionMock).not.toHaveBeenCalled();
  });

  it("falha de persistência é retryable para convergir na reentrega", async () => {
    persistSupportQuestionMock.mockRejectedValueOnce(new Error("database unavailable"));
    const { deps, lines } = setup();

    const outcome = await run(deps, lines);

    expect(outcome).toEqual({
      status: "failed",
      retryable: true,
      reason: "database unavailable",
    });
  });
});
