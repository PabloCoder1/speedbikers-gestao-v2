import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { fetchSupportQuestions } from "./ml-support-questions-fetch.js";
import type { recordSyncRunFailure, recordSyncRunSuccess } from "./sync-runs.js";

type FetchSupportQuestions = typeof fetchSupportQuestions;

const fetchSupportQuestionsMock = vi.hoisted(() => vi.fn<FetchSupportQuestions>());
const recordSyncRunSuccessMock = vi.hoisted(() => vi.fn<typeof recordSyncRunSuccess>());
const recordSyncRunFailureMock = vi.hoisted(() => vi.fn<typeof recordSyncRunFailure>());

vi.mock("./ml-support-questions-fetch.js", () => ({
  fetchSupportQuestions: fetchSupportQuestionsMock,
}));

vi.mock("./sync-runs.js", () => ({
  recordSyncRunSuccess: recordSyncRunSuccessMock,
  recordSyncRunFailure: recordSyncRunFailureMock,
}));

const { createSyncSupportQuestionsReconcileHandler } = await import(
  "./sync-support-questions-reconcile.js"
);

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const SELLER_ID = 419_059_118;
const NOW = new Date("2026-08-25T19:00:00.000Z");
const ENCRYPTION_KEY = randomBytes(32);

const OAUTH_CONFIG = { clientId: "APP_ID_123", clientSecret: "segredo-de-teste", redirectUri: "" };

const ENVELOPE = {
  jobType: "sync.support.questions.reconcile",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b31",
  organizationId: ORGANIZATION_ID,
  dedupeKey: "support-questions:loja:2026-08-25:3",
  attempt: 1,
  enqueuedAt: NOW.toISOString(),
};

const DEFAULT_ACCOUNT = {
  id: ML_ACCOUNT_ID,
  organization_id: ORGANIZATION_ID,
  seller_id: SELLER_ID,
  status: "CONNECTED",
};

const OK_RESULT = {
  itemsProcessed: 3,
  itemsFailed: 0,
  itemsRejected: 0,
  remoteTotal: 3,
  truncated: false,
};

function chain<T>(result: T) {
  const self = { eq: () => self, maybeSingle: () => Promise.resolve(result) };
  return self;
}

interface FakeDbOptions {
  account?: typeof DEFAULT_ACCOUNT | Record<string, unknown> | null;
  accountError?: { message: string } | null;
  /** Sem linha de credencial: `ensureAccessToken` falha definitivo, sem tocar a rede. */
  credentialsMissing?: boolean;
}

function fakeDb(options: FakeDbOptions = {}) {
  const account = "account" in options ? options.account : DEFAULT_ACCOUNT;

  return {
    from: (table: string) => ({
      select: () => {
        if (table === "ml_accounts") {
          return chain({ data: account ?? null, error: options.accountError ?? null });
        }

        if (table === "ml_credentials") {
          if (options.credentialsMissing === true) {
            return chain({ data: null, error: null });
          }

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
  };
}

function run(options: FakeDbOptions = {}, payload: unknown = { mlAccountId: ML_ACCOUNT_ID }) {
  const lines: string[] = [];
  const client: MercadoLivreClient = { request: () => Promise.reject(new Error("não usado")) };

  const handler = createSyncSupportQuestionsReconcileHandler({
    db: fakeDb(options) as never,
    mercadoLivre: client,
    oauth: OAUTH_CONFIG,
    encryptionKey: ENCRYPTION_KEY,
    now: () => NOW,
  });

  return {
    lines,
    outcome: handler(ENVELOPE, {
      payload,
      logger: createLogger({}, { sink: (line) => lines.push(line) }),
    }),
  };
}

beforeEach(() => {
  fetchSupportQuestionsMock.mockReset();
  recordSyncRunSuccessMock.mockReset();
  recordSyncRunFailureMock.mockReset();
  recordSyncRunSuccessMock.mockResolvedValue(undefined);
  recordSyncRunFailureMock.mockResolvedValue(undefined);
  fetchSupportQuestionsMock.mockResolvedValue(OK_RESULT);
});

describe("createSyncSupportQuestionsReconcileHandler", () => {
  it("payload sem mlAccountId não repete — reprocessar não conserta o payload", async () => {
    const { outcome } = run({}, {});

    expect(await outcome).toEqual({
      status: "failed",
      retryable: false,
      reason: "payload sem mlAccountId",
    });
    expect(fetchSupportQuestionsMock).not.toHaveBeenCalled();
  });

  it("conta inexistente conclui sem trabalho, sem gravar sync_run", async () => {
    const { outcome, lines } = run({ account: null });

    expect(await outcome).toEqual({ status: "done", processed: 0 });
    expect(recordSyncRunSuccessMock).not.toHaveBeenCalled();
    expect(recordSyncRunFailureMock).not.toHaveBeenCalled();
    expect(lines.join()).toContain("sync_support_questions_reconcile_account_missing");
  });

  it("conta não CONNECTED conclui sem trabalho", async () => {
    const { outcome, lines } = run({ account: { ...DEFAULT_ACCOUNT, status: "REVOKED" } });

    expect(await outcome).toEqual({ status: "done", processed: 0 });
    expect(fetchSupportQuestionsMock).not.toHaveBeenCalled();
    expect(lines.join()).toContain("sync_support_questions_reconcile_account_not_connected");
  });

  it("conta CONNECTED sem seller_id é falha definitiva — sem seller não há como conferir identidade", async () => {
    const { outcome } = run({ account: { ...DEFAULT_ACCOUNT, seller_id: null } });

    expect(await outcome).toEqual({
      status: "failed",
      retryable: false,
      reason: "conta CONNECTED sem seller_id",
    });
    expect(fetchSupportQuestionsMock).not.toHaveBeenCalled();
  });

  it("caminho feliz grava sync_run com resource questions e devolve o processado", async () => {
    const { outcome, lines } = run();

    expect(await outcome).toEqual({ status: "done", processed: 3 });
    expect(recordSyncRunSuccessMock).toHaveBeenCalledTimes(1);
    expect(recordSyncRunSuccessMock.mock.calls[0]?.[1]).toMatchObject({
      organizationId: ORGANIZATION_ID,
      mlAccountId: ML_ACCOUNT_ID,
      resource: "questions",
      channel: "reconciliation",
      itemsProcessed: 3,
      status: "done",
    });
    expect(lines.join()).toContain("sync_support_questions_reconcile_done");
  });

  it("passa o seller_id da conta para a varredura conferir a identidade de cada pergunta", async () => {
    await run().outcome;

    expect(fetchSupportQuestionsMock.mock.calls[0]?.[0]).toMatchObject({
      organizationId: ORGANIZATION_ID,
      mlAccountId: ML_ACCOUNT_ID,
      sellerId: SELLER_ID,
    });
  });

  it("falha ao persistir alguma pergunta vira sync_run PARCIAL, não done", async () => {
    fetchSupportQuestionsMock.mockResolvedValue({ ...OK_RESULT, itemsFailed: 2 });

    expect(await run().outcome).toEqual({ status: "done", processed: 3 });

    const gravado = recordSyncRunSuccessMock.mock.calls[0]?.[1];
    expect(gravado?.status).toBe("partial");
    expect(gravado?.reason).toContain("2 pergunta(s) falharam ao persistir");
  });

  it("pergunta recusada por seller divergente também vira PARCIAL", async () => {
    fetchSupportQuestionsMock.mockResolvedValue({ ...OK_RESULT, itemsRejected: 1 });

    await run().outcome;

    const gravado = recordSyncRunSuccessMock.mock.calls[0]?.[1];
    expect(gravado?.status).toBe("partial");
    expect(gravado?.reason).toContain("seller_id divergente");
  });

  it("varredura truncada vira PARCIAL — não reporta done sobre um recorte", async () => {
    fetchSupportQuestionsMock.mockResolvedValue({
      ...OK_RESULT,
      truncated: true,
      remoteTotal: 5_000,
    });

    await run().outcome;

    const gravado = recordSyncRunSuccessMock.mock.calls[0]?.[1];
    expect(gravado?.status).toBe("partial");
    expect(gravado?.reason).toContain("truncada");
  });

  it("429 do Mercado Livre grava sync_run de falha e pede retry", async () => {
    fetchSupportQuestionsMock.mockRejectedValue(
      new MercadoLivreApiError("429 do Mercado Livre", {
        status: 429,
        errorClass: "retryable",
        url: "/my/received_questions/search",
      }),
    );

    expect(await run().outcome).toMatchObject({ status: "failed", retryable: true });
    expect(recordSyncRunFailureMock.mock.calls[0]?.[1]).toMatchObject({
      resource: "questions",
      errorClass: "retryable",
    });
  });

  it("erro definitivo do Mercado Livre não repete", async () => {
    fetchSupportQuestionsMock.mockRejectedValue(
      new MercadoLivreApiError("403 do Mercado Livre", {
        status: 403,
        errorClass: "not_retryable",
        url: "/my/received_questions/search",
      }),
    );

    expect(await run().outcome).toMatchObject({ status: "failed", retryable: false });
    expect(recordSyncRunFailureMock.mock.calls[0]?.[1]).toMatchObject({
      errorClass: "not_retryable",
    });
  });

  it("falha de token grava sync_run de falha antes de qualquer chamada remota", async () => {
    const { outcome } = run({ credentialsMissing: true });

    expect(await outcome).toMatchObject({ status: "failed" });
    expect(fetchSupportQuestionsMock).not.toHaveBeenCalled();
    expect(recordSyncRunFailureMock).toHaveBeenCalledTimes(1);
  });
});
