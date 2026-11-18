import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { Caller } from "./auth.js";
import type { EnqueueRequest } from "./enqueue.js";
import type { SupportReplyDeps } from "./support-reply.js";
import { requestSupportReply, supportReplyRequestSchema } from "./support-reply.js";

const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const OUTRA_ORG = "22222222-0000-4000-8000-000000000002";
const CASE_ID = "cccccccc-0000-4000-8000-000000000001";
const ATTEMPT_ID = "eeeeeeee-0000-4000-8000-000000000001";
const QUESTION_ID = "11436370259";

const CALLER: Caller = {
  userId: "aaaaaaaa-0000-4000-8000-000000000001",
  organizationId: ORGANIZATION_ID,
  role: "OPERADOR",
};

const DEFAULT_CASE = {
  id: CASE_ID,
  organization_id: ORGANIZATION_ID,
  ml_account_id: "aaaaaaaa-0000-4000-8000-0000000000aa",
  channel: "QUESTION",
  external_case_id: QUESTION_ID,
  ml_accounts: { slug: "speedbikers-loja-1" },
};

const REQUEST = { clientRequestId: "req-1", text: "Serve sim, amigo." };
const QUEUE = "ml-sync-speedbikers-loja-1";
const EXISTING_ATTEMPT = {
  id: ATTEMPT_ID,
  status: "PENDING",
  error_message: null,
  support_case_id: CASE_ID,
  ml_account_id: DEFAULT_CASE.ml_account_id,
  requested_by: CALLER.userId,
  final_text: REQUEST.text,
  suggested_text: null,
  dispatch_queue: QUEUE,
  dispatch_started_at: null,
};

function chain<T>(result: T) {
  const self = { eq: () => self, maybeSingle: () => Promise.resolve(result) };
  return self;
}

interface Options {
  supportCase?: Record<string, unknown> | null;
  existingAttempt?: Record<string, unknown> | null;
  attemptOnInsertConflict?: Record<string, unknown>;
  insertError?: { code?: string; message: string } | null;
  queueFailure?: "before_create" | "after_create";
  /** `false` = o chamador NÃO tem `user_account_permissions` para a conta do case. */
  accountPermission?: boolean;
}

function deps(options: Options = {}): {
  deps: SupportReplyDeps;
  enqueued: EnqueueRequest[];
  inserted: Record<string, unknown>[];
  lines: string[];
} {
  const enqueued: EnqueueRequest[] = [];
  const inserted: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const supportCase = "supportCase" in options ? options.supportCase : DEFAULT_CASE;
  let attempt = options.existingAttempt ?? null;
  const tasks = new Set<string>();

  const db = {
    from: (table: string) => ({
      select: () => {
        if (table === "support_cases") {
          return chain({ data: supportCase ?? null, error: null });
        }

        if (table === "user_account_permissions") {
          const permitido = options.accountPermission ?? true;

          return chain({ data: permitido ? { user_id: CALLER.userId } : null, error: null });
        }

        if (table === "support_reply_attempts") {
          return chain({ data: attempt, error: null });
        }

        throw new Error(`select inesperado em ${table}`);
      },
      insert: (row: Record<string, unknown>) => {
        inserted.push(row);
        if (options.insertError == null) {
          attempt = { ...row, id: ATTEMPT_ID, dispatch_started_at: null };
        } else if (options.attemptOnInsertConflict !== undefined) {
          attempt = options.attemptOnInsertConflict;
        }

        return {
          select: () => ({
            single: () =>
              Promise.resolve(
                options.insertError == null
                  ? { data: { id: ATTEMPT_ID }, error: null }
                  : { data: null, error: options.insertError },
              ),
          }),
        };
      },
    }),
  };

  return {
    enqueued,
    inserted,
    lines,
    deps: {
      db: db as never,
      logger: createLogger({}, { sink: (line) => lines.push(line) }),
      now: () => new Date("2026-08-26T14:00:00.000Z"),
      enqueuer: {
        enqueue: (request) => {
          enqueued.push(request);
          const task = `${request.queue}/${request.dedupeKey}`;
          const deduplicated = tasks.has(task);

          if (enqueued.length === 1 && options.queueFailure === "before_create") {
            return Promise.reject(new Error("Cloud Tasks indisponível"));
          }

          tasks.add(task);

          if (enqueued.length === 1 && options.queueFailure === "after_create") {
            return Promise.reject(new Error("Confirmação do Cloud Tasks perdida"));
          }

          return Promise.resolve({
            taskName: "t",
            deduplicated,
            envelope: {
              jobType: request.jobType,
              jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b42",
              organizationId: request.organizationId,
              dedupeKey: request.dedupeKey,
              attempt: 1,
              enqueuedAt: "2026-08-26T14:00:00.000Z",
            },
          });
        },
      },
    },
  };
}

describe("supportReplyRequestSchema", () => {
  it("recusa texto acima de 2.000 caracteres — o limite é da API (D-083)", () => {
    const result = supportReplyRequestSchema.safeParse({
      clientRequestId: "req-1",
      text: "a".repeat(2_001),
    });

    expect(result.success).toBe(false);
  });

  it("recusa texto vazio ou só espaços", () => {
    expect(supportReplyRequestSchema.safeParse({ clientRequestId: "r", text: "   " }).success).toBe(false);
  });

  it("exige clientRequestId — sem ele não há como impedir resposta duplicada", () => {
    expect(supportReplyRequestSchema.safeParse({ text: "oi" }).success).toBe(false);
  });
});

describe("requestSupportReply (D-096)", () => {
  it("grava a tentativa PENDING e enfileira na fila da conta", async () => {
    const ctx = deps();

    const outcome = await requestSupportReply(ctx.deps, CALLER, CASE_ID, REQUEST);

    expect(outcome).toEqual({ status: "queued", attemptId: ATTEMPT_ID });

    // A linha PENDING nasce ANTES de enfileirar: se a fila engolir a task,
    // sobra o registro dizendo "não sabemos se saiu".
    expect(ctx.inserted[0]).toMatchObject({
      status: "PENDING",
      client_request_id: "req-1",
      final_text: "Serve sim, amigo.",
      requested_by: CALLER.userId,
      dispatch_queue: QUEUE,
    });

    expect(ctx.enqueued[0]).toMatchObject({
      jobType: "support.reply.send.v2",
      queue: QUEUE,
      dedupeKey: `support-reply:${ATTEMPT_ID}`,
      payload: { attemptId: ATTEMPT_ID },
    });
  });

  it("o TEXTO da resposta nunca entra no log", async () => {
    const ctx = deps();

    await requestSupportReply(ctx.deps, CALLER, CASE_ID, REQUEST);

    expect(ctx.lines.join()).toContain("support_reply_queued");
    expect(ctx.lines.join()).not.toContain("Serve sim, amigo");
  });

  it("case de OUTRA organização é `not_found`, nunca `sem permissão`", async () => {
    // A segunda resposta revelaria que o atendimento existe.
    const ctx = deps({ supportCase: { ...DEFAULT_CASE, organization_id: OUTRA_ORG } });

    expect(await requestSupportReply(ctx.deps, CALLER, CASE_ID, REQUEST)).toEqual({
      status: "not_found",
    });
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("case inexistente é `not_found`", async () => {
    const ctx = deps({ supportCase: null });

    expect(await requestSupportReply(ctx.deps, CALLER, CASE_ID, REQUEST)).toEqual({
      status: "not_found",
    });
  });

  it("sem permissão NA CONTA é `not_found` — papel e organização não bastam", async () => {
    // A RLS impede este usuário até de LER o case; só o envio, a única
    // escrita real no Mercado Livre, não checava a conta.
    const ctx = deps({ accountPermission: false });

    expect(await requestSupportReply(ctx.deps, CALLER, CASE_ID, REQUEST)).toEqual({
      status: "not_found",
    });
    expect(ctx.enqueued).toHaveLength(0);
    expect(ctx.inserted).toHaveLength(0);
  });

  it("ADMIN alcança toda conta da própria organização, sem linha de permissão", async () => {
    // Espelha o ramo `m.role = 'ADMIN'` de `private.has_account_access`.
    const ctx = deps({ accountPermission: false });

    const outcome = await requestSupportReply(ctx.deps, { ...CALLER, role: "ADMIN" }, CASE_ID, REQUEST);

    expect(outcome).toMatchObject({ status: "queued" });
    expect(ctx.enqueued).toHaveLength(1);
  });

  it("canal que não é Pergunta é recusado — mensagens e claims não estão integrados", async () => {
    const ctx = deps({ supportCase: { ...DEFAULT_CASE, channel: "CLAIM" } });

    expect(await requestSupportReply(ctx.deps, CALLER, CASE_ID, REQUEST)).toMatchObject({
      status: "invalid",
    });
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("mesma chave de uma tentativa BEM-SUCEDIDA não reenvia", async () => {
    const ctx = deps({
      existingAttempt: { ...EXISTING_ATTEMPT, status: "SUCCEEDED" },
    });

    expect(await requestSupportReply(ctx.deps, CALLER, CASE_ID, REQUEST)).toEqual({
      status: "already_sent",
      attemptId: ATTEMPT_ID,
    });
    expect(ctx.enqueued).toHaveLength(0);
    expect(ctx.inserted).toHaveLength(0);
  });

  it.each(["before_create", "after_create"] as const)(
    "recupera a mesma tentativa quando o Cloud Tasks falha (%s)",
    async (queueFailure) => {
      const ctx = deps({ queueFailure });

      expect(await requestSupportReply(ctx.deps, CALLER, CASE_ID, REQUEST)).toMatchObject({
        status: "error",
      });
      expect(await requestSupportReply(ctx.deps, CALLER, CASE_ID, REQUEST)).toEqual({
        status: queueFailure === "before_create" ? "queued" : "in_flight",
        attemptId: ATTEMPT_ID,
      });
      expect(ctx.inserted).toHaveLength(1);
      expect(ctx.enqueued).toHaveLength(2);
      expect(ctx.enqueued[1]).toEqual(ctx.enqueued[0]);
    },
  );

  it.each([
    { dispatch_queue: null },
    { dispatch_started_at: "2026-08-26T14:00:00Z" },
  ])("mantém PENDING no legado ou após o início do envio (%j)", async (patch) => {
    const ctx = deps({ existingAttempt: { ...EXISTING_ATTEMPT, ...patch } });

    expect(await requestSupportReply(ctx.deps, CALLER, CASE_ID, REQUEST)).toEqual({
      status: "in_flight",
      attemptId: ATTEMPT_ID,
    });
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("reutiliza a fila gravada mesmo que o slug da conta tenha mudado", async () => {
    const ctx = deps({
      existingAttempt: EXISTING_ATTEMPT,
      supportCase: { ...DEFAULT_CASE, ml_accounts: { slug: "renomeada" } },
    });

    expect(await requestSupportReply(ctx.deps, CALLER, CASE_ID, REQUEST)).toMatchObject({ status: "queued" });
    expect(ctx.enqueued[0]).toMatchObject({ queue: QUEUE, payload: { attemptId: ATTEMPT_ID } });
  });

  it.each([
    { requested_by: "outro-usuario" },
    { support_case_id: "outro-caso" },
    { ml_account_id: "outra-conta" },
    { final_text: "outro texto" },
    { suggested_text: "outra sugestão" },
  ])("recusa reutilização da chave com confirmação diferente (%j)", async (patch) => {
    const ctx = deps({ existingAttempt: { ...EXISTING_ATTEMPT, ...patch } });

    expect(await requestSupportReply(ctx.deps, CALLER, CASE_ID, REQUEST)).toMatchObject({ status: "invalid" });
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("mesma chave de uma tentativa que FALHOU devolve o motivo, sem reenviar", async () => {
    // Reenviar exige nova confirmação humana, com chave nova — e quem
    // confirma vê antes que a anterior falhou.
    const ctx = deps({
      existingAttempt: { ...EXISTING_ATTEMPT, status: "FAILED", error_message: "pergunta já respondida" },
    });

    expect(await requestSupportReply(ctx.deps, CALLER, CASE_ID, REQUEST)).toEqual({
      status: "previously_failed",
      attemptId: ATTEMPT_ID,
      reason: "pergunta já respondida",
    });
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("colisão com uma confirmação diferente no mesmo caso mantém a tentativa anterior", async () => {
    const ctx = deps({ insertError: { code: "23505", message: "duplicate key" } });

    expect(await requestSupportReply(ctx.deps, CALLER, CASE_ID, REQUEST)).toMatchObject({
      status: "in_flight",
    });
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("corrida no INSERT com a mesma confirmação reutiliza a tentativa vencedora", async () => {
    const ctx = deps({
      insertError: { code: "23505", message: "duplicate key" },
      attemptOnInsertConflict: EXISTING_ATTEMPT,
    });

    expect(await requestSupportReply(ctx.deps, CALLER, CASE_ID, REQUEST)).toEqual({
      status: "queued",
      attemptId: ATTEMPT_ID,
    });
    expect(ctx.enqueued).toEqual([expect.objectContaining({
      dedupeKey: `support-reply:${ATTEMPT_ID}`,
      payload: { attemptId: ATTEMPT_ID },
    })]);
  });

  it("identificador remoto não numérico é recusado antes de qualquer escrita", async () => {
    const ctx = deps({ supportCase: { ...DEFAULT_CASE, external_case_id: "abc" } });

    expect(await requestSupportReply(ctx.deps, CALLER, CASE_ID, REQUEST)).toMatchObject({
      status: "invalid",
    });
    expect(ctx.inserted).toHaveLength(0);
  });

  it("conta sem slug não enfileira em fila inventada", async () => {
    const ctx = deps({ supportCase: { ...DEFAULT_CASE, ml_accounts: null } });

    expect(await requestSupportReply(ctx.deps, CALLER, CASE_ID, REQUEST)).toMatchObject({
      status: "error",
    });
    expect(ctx.enqueued).toHaveLength(0);
  });
});
