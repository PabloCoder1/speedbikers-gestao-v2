import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { persistSupportQuestion } from "./persist-support-question.js";

type PersistSupportQuestion = typeof persistSupportQuestion;

const persistSupportQuestionMock = vi.hoisted(() => vi.fn<PersistSupportQuestion>());

vi.mock("./persist-support-question.js", () => ({
  persistSupportQuestion: persistSupportQuestionMock,
}));

const { createSendSupportReplyHandler } = await import("./send-support-reply.js");

const ATTEMPT_ID = "eeeeeeee-0000-4000-8000-000000000001";
const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const QUESTION_ID = 11_436_370_259;
const NOW = new Date("2026-08-26T14:00:00.000Z");
const ENCRYPTION_KEY = randomBytes(32);

const OAUTH = { clientId: "APP_ID", clientSecret: "segredo", redirectUri: "" };

const ENVELOPE = {
  jobType: "support.reply.send",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b41",
  organizationId: ORGANIZATION_ID,
  dedupeKey: "support-reply:req-1",
  attempt: 1,
  enqueuedAt: NOW.toISOString(),
};

const QUESTION_UNANSWERED = {
  id: QUESTION_ID,
  seller_id: 419_059_118,
  buyer_id: 419_067_349,
  item_id: "MLB1623490410",
  status: "UNANSWERED",
  text: "Serve na CB 500X?",
  date_created: "2026-08-26T10:00:00.000-03:00",
  answer: null,
};

const DEFAULT_ATTEMPT = {
  id: ATTEMPT_ID,
  organization_id: ORGANIZATION_ID,
  ml_account_id: ML_ACCOUNT_ID,
  support_case_id: "cccccccc-0000-4000-8000-000000000001",
  final_text: "Serve sim, amigo.",
  status: "PENDING",
  support_cases: { external_case_id: String(QUESTION_ID), channel: "QUESTION" },
};

function chain<T>(result: T) {
  const self = { eq: () => self, maybeSingle: () => Promise.resolve(result) };
  return self;
}

interface FakeDbOptions {
  attempt?: Record<string, unknown> | null;
  credentialsMissing?: boolean;
}

function fakeDb(options: FakeDbOptions = {}): {
  db: unknown;
  updates: Record<string, unknown>[];
} {
  const attempt = "attempt" in options ? options.attempt : DEFAULT_ATTEMPT;
  const updates: Record<string, unknown>[] = [];

  const db = {
    from: (table: string) => ({
      select: () => {
        if (table === "support_reply_attempts") {
          return chain({ data: attempt ?? null, error: null });
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
      update: (patch: Record<string, unknown>) => {
        updates.push({ table, ...patch });

        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  };

  return { db, updates };
}

type Behavior =
  | { kind: "ok" }
  | { kind: "revalidate_fails"; error: Error }
  | { kind: "post_fails"; error: Error }
  | { kind: "resync_fails"; error: Error }
  | { kind: "question"; value: Record<string, unknown> };

function fakeClient(behavior: Behavior = { kind: "ok" }): {
  client: MercadoLivreClient;
  calls: { method: string; path: string }[];
} {
  const calls: { method: string; path: string }[] = [];
  let questionCalls = 0;

  const request = <T>(options: RequestOptions<T>): Promise<T> => {
    calls.push({ method: options.method, path: options.path });

    if (options.path === "/answers") {
      if (behavior.kind === "post_fails") {
        return Promise.reject(behavior.error);
      }

      return Promise.resolve().then(() => options.schema.parse({ id: QUESTION_ID }));
    }

    questionCalls += 1;

    if (behavior.kind === "revalidate_fails" && questionCalls === 1) {
      return Promise.reject(behavior.error);
    }

    if (behavior.kind === "resync_fails" && questionCalls === 2) {
      return Promise.reject(behavior.error);
    }

    const payload = behavior.kind === "question" ? behavior.value : QUESTION_UNANSWERED;

    return Promise.resolve().then(() => options.schema.parse(payload));
  };

  return { client: { request }, calls };
}

function run(
  dbOptions: FakeDbOptions = {},
  behavior: Behavior = { kind: "ok" },
  payload: unknown = { attemptId: ATTEMPT_ID },
) {
  const lines: string[] = [];
  const { db, updates } = fakeDb(dbOptions);
  const { client, calls } = fakeClient(behavior);

  const handler = createSendSupportReplyHandler({
    db: db as never,
    mercadoLivre: client,
    oauth: OAUTH,
    encryptionKey: ENCRYPTION_KEY,
    now: () => NOW,
  });

  return {
    updates,
    calls,
    lines,
    outcome: handler(ENVELOPE, {
      payload,
      logger: createLogger({}, { sink: (line) => lines.push(line) }),
    }),
  };
}

beforeEach(() => {
  persistSupportQuestionMock.mockReset();
  persistSupportQuestionMock.mockResolvedValue({
    supportCaseId: "cccccccc-0000-4000-8000-000000000001",
    messagesUpserted: 2,
    linkMode: "EXTERNAL",
        transitionApplied: false,
  });
});

describe("createSendSupportReplyHandler (D-096)", () => {
  it("caminho feliz: revalida, envia, resolve SUCCEEDED e re-sincroniza", async () => {
    const ctx = run();

    expect(await ctx.outcome).toEqual({ status: "done", processed: 1 });

    // Ordem importa: revalidar ANTES de postar.
    expect(ctx.calls.map((call) => call.path)).toEqual([
      `/questions/${String(QUESTION_ID)}`,
      "/answers",
      `/questions/${String(QUESTION_ID)}`,
    ]);

    expect(ctx.updates[0]).toMatchObject({
      table: "support_reply_attempts",
      status: "SUCCEEDED",
      remote_message_id: String(QUESTION_ID),
    });

    // A mensagem outbound vem do que o Mercado Livre registrou, relido — não
    // do que a `api` acha que mandou.
    expect(persistSupportQuestionMock).toHaveBeenCalledTimes(1);
  });

  it("o TEXTO enviado nunca entra no log", async () => {
    const ctx = run();
    await ctx.outcome;

    expect(ctx.lines.join()).toContain("support_reply_sent");
    expect(ctx.lines.join()).not.toContain("Serve sim, amigo");
  });

  it("tentativa JÁ RESOLVIDA não reenvia — reentrega do Cloud Tasks não vira segunda resposta", async () => {
    const ctx = run({ attempt: { ...DEFAULT_ATTEMPT, status: "SUCCEEDED" } });

    expect(await ctx.outcome).toEqual({ status: "done", processed: 0 });
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.lines.join()).toContain("support_reply_already_resolved");
  });

  it.each([
    ["ANSWERED", "não está mais aberta"],
    ["DELETED", "não está mais aberta"],
    ["CLOSED_UNANSWERED", "não está mais aberta"],
  ])("pergunta em %s no momento do envio: NÃO envia e resolve FAILED", async (status, trecho) => {
    const ctx = run({}, { kind: "question", value: { ...QUESTION_UNANSWERED, status } });

    const outcome = await ctx.outcome;

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(outcome).toHaveProperty("reason", expect.stringContaining(trecho));
    expect(ctx.calls.some((call) => call.path === "/answers")).toBe(false);
    expect(ctx.updates[0]).toMatchObject({ status: "FAILED", error_code: "estado_remoto" });
  });

  it("pergunta em hold: não envia — a dica local pode estar velha (D-086)", async () => {
    const ctx = run({}, { kind: "question", value: { ...QUESTION_UNANSWERED, hold: true } });

    expect(await ctx.outcome).toMatchObject({ status: "failed", retryable: false });
    expect(ctx.calls.some((call) => call.path === "/answers")).toBe(false);
  });

  it("**5xx no POST /answers NÃO é retryable** — pode ter chegado ao comprador", async () => {
    // É a diferença deste job para todo outro do projeto. Num sync, 5xx
    // significa "tente de novo"; aqui pode significar que a resposta saiu.
    const ctx = run(
      {},
      {
        kind: "post_fails",
        error: new MercadoLivreApiError("500 do Mercado Livre", {
          status: 500,
          errorClass: "retryable",
          url: "/answers",
        }),
      },
    );

    const outcome = await ctx.outcome;

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(ctx.updates[0]).toMatchObject({ status: "FAILED", error_code: "envio" });
  });

  it("falha ao REVALIDAR (antes do POST) é retryable e NÃO resolve a tentativa", async () => {
    // Nada saiu ainda: a tentativa segue PENDING e a próxima entrega tenta.
    const ctx = run(
      {},
      {
        kind: "revalidate_fails",
        error: new MercadoLivreApiError("503", {
          status: 503,
          errorClass: "retryable",
          url: "/questions/x",
        }),
      },
    );

    expect(await ctx.outcome).toMatchObject({ status: "failed", retryable: true });
    expect(ctx.updates).toHaveLength(0);
    expect(ctx.calls.some((call) => call.path === "/answers")).toBe(false);
  });

  it("falha na RE-SINCRONIZAÇÃO não desfaz o envio nem falha o job", async () => {
    // A resposta saiu e está registrada; a mensagem chega na próxima
    // reconciliação (10 min, D-092).
    const ctx = run({}, { kind: "resync_fails", error: new Error("timeout") });

    expect(await ctx.outcome).toEqual({ status: "done", processed: 1 });
    expect(ctx.updates[0]).toMatchObject({ status: "SUCCEEDED" });
    expect(ctx.lines.join()).toContain("support_reply_resync_failed");
  });

  it("tentativa de outra organização é recusada sem tocar a rede", async () => {
    const ctx = run({ attempt: { ...DEFAULT_ATTEMPT, organization_id: "22222222-0000-4000-8000-000000000002" } });

    expect(await ctx.outcome).toMatchObject({ status: "failed", retryable: false });
    expect(ctx.calls).toHaveLength(0);
  });

  it("atendimento que não é Pergunta é recusado definitivamente", async () => {
    const ctx = run({
      attempt: { ...DEFAULT_ATTEMPT, support_cases: { external_case_id: "1", channel: "CLAIM" } },
    });

    expect(await ctx.outcome).toMatchObject({ status: "failed", retryable: false });
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.updates[0]).toMatchObject({ status: "FAILED", error_code: "escopo" });
  });

  it("payload sem attemptId não repete", async () => {
    const ctx = run({}, { kind: "ok" }, {});

    expect(await ctx.outcome).toEqual({
      status: "failed",
      retryable: false,
      reason: "payload sem attemptId",
    });
  });

  it("tentativa inexistente não repete", async () => {
    const ctx = run({ attempt: null });

    expect(await ctx.outcome).toMatchObject({ status: "failed", retryable: false });
    expect(ctx.calls).toHaveLength(0);
  });

  it("falha de credencial resolve FAILED sem tocar a rede", async () => {
    const ctx = run({ credentialsMissing: true });

    expect(await ctx.outcome).toMatchObject({ status: "failed", retryable: false });
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.updates[0]).toMatchObject({ status: "FAILED", error_code: "token" });
  });
});
