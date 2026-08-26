import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { EnqueueRequest } from "./enqueue.js";
import type { SupportQuestionsScheduleDeps } from "./support-questions-schedule.js";
import { triggerSupportQuestionsReconcile } from "./support-questions-schedule.js";

const ACCOUNTS = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", organization_id: "org-1", slug: "speedbikers-loja-1" },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", organization_id: "org-1", slug: "sbmotos" },
];

function fakeDb(options: { accountsFail?: boolean } = {}): SupportQuestionsScheduleDeps["db"] {
  return {
    from: () => ({
      select: () => ({
        eq: () =>
          Promise.resolve(
            options.accountsFail === true
              ? { data: null, error: { message: "boom" } }
              : { data: ACCOUNTS, error: null },
          ),
      }),
    }),
  } as unknown as SupportQuestionsScheduleDeps["db"];
}

function deps(options: {
  accountsFail?: boolean;
  deduplicateSlug?: string;
  now?: string;
} = {}): { deps: SupportQuestionsScheduleDeps; enqueued: EnqueueRequest[] } {
  const enqueued: EnqueueRequest[] = [];
  const now = options.now ?? "2026-08-25T18:20:00.000Z";

  return {
    enqueued,
    deps: {
      db: fakeDb(options),
      logger: createLogger({}, { sink: () => undefined }),
      now: () => new Date(now),
      enqueuer: {
        enqueue: (request) => {
          enqueued.push(request);

          return Promise.resolve({
            taskName: "t",
            deduplicated: request.queue.endsWith(options.deduplicateSlug ?? "__none__"),
            envelope: {
              jobType: request.jobType,
              jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b32",
              organizationId: request.organizationId,
              dedupeKey: request.dedupeKey,
              attempt: 1,
              enqueuedAt: now,
            },
          });
        },
      },
    },
  };
}

describe("triggerSupportQuestionsReconcile (D-089)", () => {
  it("enfileira a reconciliação para cada conta CONNECTED, na fila da própria conta", async () => {
    const { deps: d, enqueued } = deps();

    const outcome = await triggerSupportQuestionsReconcile(d);

    expect(outcome).toEqual({ accountsScanned: 2, enqueued: 2, deduplicated: 0 });
    expect(enqueued[0]).toMatchObject({
      jobType: "sync.support.questions.reconcile",
      organizationId: "org-1",
      queue: "ml-sync-speedbikers-loja-1",
      dedupeKey: "support-questions:speedbikers-loja-1:2026-08-25T18:20",
      payload: { mlAccountId: ACCOUNTS[0]?.id },
    });
  });

  it("duas chamadas no MESMO minuto produzem a mesma chave — o caso é retry do Scheduler", async () => {
    const primeira = deps({ now: "2026-08-26T12:10:03.000Z" });
    const segunda = deps({ now: "2026-08-26T12:10:47.000Z" });

    await triggerSupportQuestionsReconcile(primeira.deps);
    await triggerSupportQuestionsReconcile(segunda.deps);

    expect(primeira.enqueued[0]?.dedupeKey).toBe(segunda.enqueued[0]?.dedupeKey);
  });

  it("execuções consecutivas do cron de 10 minutos NUNCA colidem (D-051, D-092)", async () => {
    // A granularidade da chave tem que acompanhar a cadência. Com a chave
    // antiga (`{dia}:{bloco-6h}`), as seis rodadas de uma hora colapsavam
    // numa só e cinco perguntas ficavam esperando o próximo bloco.
    const chaves = await Promise.all(
      ["12:00", "12:10", "12:20", "12:30", "12:40", "12:50"].map(async (hora) => {
        const ctx = deps({ now: `2026-08-26T${hora}:00.000Z` });
        await triggerSupportQuestionsReconcile(ctx.deps);
        return ctx.enqueued[0]?.dedupeKey;
      }),
    );

    expect(new Set(chaves).size).toBe(6);
  });

  it("um disparo manual não queima a rodada natural seguinte", async () => {
    // Regressão do achado de 2026-08-25 (D-091): com chave por bloco de 6h,
    // um `gcloud scheduler jobs run` consumia o bloco do dia e a execução
    // natural seguinte era descartada em silêncio.
    const manual = deps({ now: "2026-08-26T12:07:00.000Z" });
    const natural = deps({ now: "2026-08-26T12:10:00.000Z" });

    await triggerSupportQuestionsReconcile(manual.deps);
    await triggerSupportQuestionsReconcile(natural.deps);

    expect(manual.enqueued[0]?.dedupeKey).not.toBe(natural.enqueued[0]?.dedupeKey);
  });

  it("contabiliza deduplicados separadamente de enfileirados", async () => {
    const { deps: d } = deps({ deduplicateSlug: "sbmotos" });

    expect(await triggerSupportQuestionsReconcile(d)).toEqual({
      accountsScanned: 2,
      enqueued: 1,
      deduplicated: 1,
    });
  });

  it("devolve zero sem lançar quando a listagem de contas falha", async () => {
    const { deps: d, enqueued } = deps({ accountsFail: true });

    expect(await triggerSupportQuestionsReconcile(d)).toEqual({
      accountsScanned: 0,
      enqueued: 0,
      deduplicated: 0,
    });
    expect(enqueued).toHaveLength(0);
  });

  it("sem conta CONNECTED nenhuma, não enfileira nada", async () => {
    const { deps: d, enqueued } = deps();
    d.db = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
    } as unknown as SupportQuestionsScheduleDeps["db"];

    expect(await triggerSupportQuestionsReconcile(d)).toEqual({
      accountsScanned: 0,
      enqueued: 0,
      deduplicated: 0,
    });
    expect(enqueued).toHaveLength(0);
  });
});
