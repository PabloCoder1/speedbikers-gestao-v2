import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { WebhookDeps } from "./webhook.js";
import { mercadoLivreNotificationSchema, receiveWebhook } from "./webhook.js";

const NOTIFICATION = {
  _id: "not-1",
  resource: "/orders/2000003508426396",
  user_id: 987654321,
  topic: "orders_v2",
  application_id: 123456,
  attempts: 1,
  sent: "2026-08-21T12:00:00.000Z",
  received: "2026-08-21T12:00:00.000Z",
};

/**
 * Tópico geral `questions`, formato confirmado em `docs/MERCADO_LIVRE.md`
 * secao 2.12 (D-083): `resource: "/questions/{question_id}"`, sem array
 * `actions`, disparado tanto para a pergunta quanto para a resposta.
 */
const QUESTION_NOTIFICATION = {
  _id: "not-q-1",
  resource: "/questions/12345678901",
  user_id: 987654321,
  topic: "questions",
  application_id: 123456,
  attempts: 1,
  sent: "2026-08-25T12:00:00.000Z",
  received: "2026-08-25T12:00:00.000Z",
};

const ACCOUNT = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  organization_id: "11111111-0000-4000-8000-000000000001",
  slug: "speedbikers-loja-1",
};

/** Fake mínimo do Supabase: só a cadeia que `receiveWebhook` usa. */
function fakeDb(options: { accountExists?: boolean } = {}): WebhookDeps["db"] {
  const accountExists = options.accountExists ?? true;

  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: accountExists ? ACCOUNT : null,
              error: null,
            }),
        }),
      }),
    }),
  } as unknown as WebhookDeps["db"];
}

function deps(options: { accountExists?: boolean } = {}): {
  deps: WebhookDeps;
  enqueued: { jobType: string; organizationId: string; dedupeKey: string; queue: string; payload?: Record<string, unknown> }[];
  lines: string[];
} {
  const enqueued: {
    jobType: string;
    organizationId: string;
    dedupeKey: string;
    queue: string;
    payload?: Record<string, unknown>;
  }[] = [];
  const lines: string[] = [];

  return {
    enqueued,
    lines,
    deps: {
      db: fakeDb(options),
      logger: createLogger({}, { sink: (line) => lines.push(line) }),
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      enqueuer: {
        enqueue: (request) => {
          enqueued.push(request);

          return Promise.resolve({
            taskName: "t",
            deduplicated: false,
            envelope: {
              jobType: request.jobType,
              jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
              organizationId: request.organizationId,
              dedupeKey: request.dedupeKey,
              attempt: 1,
              enqueuedAt: "2026-08-21T12:00:00.000Z",
            },
          });
        },
      },
    },
  };
}

describe("mercadoLivreNotificationSchema", () => {
  it("aceita o formato confirmado de notificação simples", () => {
    expect(mercadoLivreNotificationSchema.safeParse(NOTIFICATION).success).toBe(true);
  });

  it("aceita `id` no lugar de `_id` — formato dos tópicos com subtópico", () => {
    const { _id, ...rest } = NOTIFICATION;
    void _id;

    const result = mercadoLivreNotificationSchema.safeParse({ ...rest, id: "not-1", actions: ["created"] });

    expect(result.success).toBe(true);
  });

  it("recusa payload sem resource", () => {
    const { resource, ...rest } = NOTIFICATION;
    void resource;

    expect(mercadoLivreNotificationSchema.safeParse(rest).success).toBe(false);
  });
});

describe("receiveWebhook", () => {
  it("resolve a conta pelo seller_id e enfileira na fila da conta", async () => {
    const ctx = deps();

    const outcome = await receiveWebhook(ctx.deps, NOTIFICATION);

    expect(outcome).toMatchObject({ status: "enqueued" });
    expect(ctx.enqueued).toEqual([
      {
        jobType: "sync.webhook.received",
        organizationId: ACCOUNT.organization_id,
        dedupeKey: "ml-webhook:/orders/2000003508426396:2026-08-21T12:00",
        queue: `ml-sync-${ACCOUNT.slug}`,
        payload: { ...NOTIFICATION, mlAccountId: ACCOUNT.id },
      },
    ]);
  });

  it("notificações repetidas do mesmo recurso têm a MESMA dedupeKey, independente do tópico", async () => {
    const ctx = deps();

    await receiveWebhook(ctx.deps, NOTIFICATION);
    await receiveWebhook(ctx.deps, { ...NOTIFICATION, topic: "items", _id: "not-2" });

    expect(ctx.enqueued[0]?.dedupeKey).toBe(ctx.enqueued[1]?.dedupeKey);
  });

  it("mesmo recurso em minutos diferentes gera dedupeKey diferente — uma mudança de status real não é descartada (D-051)", async () => {
    const ctx = deps();
    let now = new Date("2026-08-21T12:00:30.000Z");
    ctx.deps.now = () => now;

    await receiveWebhook(ctx.deps, NOTIFICATION);

    now = new Date("2026-08-21T12:05:00.000Z");
    await receiveWebhook(ctx.deps, { ...NOTIFICATION, _id: "not-2" });

    expect(ctx.enqueued[0]?.dedupeKey).not.toBe(ctx.enqueued[1]?.dedupeKey);
  });

  it("conta desconhecida não enfileira, só registra o aviso", async () => {
    const ctx = deps({ accountExists: false });

    const outcome = await receiveWebhook(ctx.deps, NOTIFICATION);

    expect(outcome).toEqual({ status: "unknown_account" });
    expect(ctx.enqueued).toHaveLength(0);
    expect(ctx.lines.join()).toContain("ml_webhook_unknown_account");
  });

  it("payload inválido não enfileira nem toca o banco", async () => {
    const ctx = deps();

    const outcome = await receiveWebhook(ctx.deps, { topic: "orders_v2" });

    expect(outcome.status).toBe("invalid_payload");
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("payload que não é objeto (string, número, null) é recusado sem lançar", async () => {
    const ctx = deps();

    await expect(receiveWebhook(ctx.deps, "nao-e-json-de-notificacao")).resolves.toMatchObject({
      status: "invalid_payload",
    });
    await expect(receiveWebhook(ctx.deps, null)).resolves.toMatchObject({ status: "invalid_payload" });
  });
});

/**
 * Tópico `questions` — primeiro tópico com job próprio no ACK (Fase 7B).
 * O handler já existia (D-087); o que faltava era o produtor.
 */
describe("receiveWebhook — tópico questions", () => {
  it("enfileira `sync.support.questions` com o questionId extraído do resource", async () => {
    const ctx = deps();

    const outcome = await receiveWebhook(ctx.deps, QUESTION_NOTIFICATION);

    expect(outcome).toMatchObject({ status: "enqueued", jobType: "sync.support.questions" });
    expect(ctx.enqueued).toEqual([
      {
        jobType: "sync.support.questions",
        organizationId: ACCOUNT.organization_id,
        dedupeKey: "ml-webhook:/questions/12345678901:2026-08-21T12:00",
        queue: `ml-sync-${ACCOUNT.slug}`,
        payload: { mlAccountId: ACCOUNT.id, questionId: 12345678901 },
      },
    ]);
  });

  it("o payload NÃO carrega a notificação inteira — o handler só aceita mlAccountId e questionId", async () => {
    const ctx = deps();

    await receiveWebhook(ctx.deps, QUESTION_NOTIFICATION);

    expect(Object.keys(ctx.enqueued[0]?.payload ?? {}).sort()).toEqual(["mlAccountId", "questionId"]);
    expect(typeof ctx.enqueued[0]?.payload?.questionId).toBe("number");
  });

  it("pergunta e resposta do MESMO question_id no mesmo minuto colapsam numa task só", async () => {
    // O tópico dispara para os dois eventos com o MESMO `resource`
    // (secao 2.12) e o handler busca o detalhe completo de qualquer jeito —
    // duas buscas no mesmo minuto seriam trabalho repetido.
    const ctx = deps();

    await receiveWebhook(ctx.deps, QUESTION_NOTIFICATION);
    await receiveWebhook(ctx.deps, { ...QUESTION_NOTIFICATION, _id: "not-q-2" });

    expect(ctx.enqueued[0]?.dedupeKey).toBe(ctx.enqueued[1]?.dedupeKey);
  });

  it("a resposta que chega minutos depois da pergunta NÃO é descartada (D-051)", async () => {
    const ctx = deps();
    let now = new Date("2026-08-25T12:00:30.000Z");
    ctx.deps.now = () => now;

    await receiveWebhook(ctx.deps, QUESTION_NOTIFICATION);

    now = new Date("2026-08-25T12:07:00.000Z");
    await receiveWebhook(ctx.deps, { ...QUESTION_NOTIFICATION, _id: "not-q-2" });

    expect(ctx.enqueued).toHaveLength(2);
    expect(ctx.enqueued[0]?.dedupeKey).not.toBe(ctx.enqueued[1]?.dedupeKey);
  });

  it.each([
    ["/questions/", "sem ID"],
    ["/questions/abc", "ID não numérico"],
    ["/questions/123/answers", "sub-recurso"],
    ["/questions/123 ", "espaço à direita"],
    ["questions/123", "sem barra inicial"],
    ["/my/received_questions/search", "endpoint de busca, não de detalhe"],
  ])("resource %s (%s) não enfileira nada e fica visível no log", async (resource) => {
    const ctx = deps();

    const outcome = await receiveWebhook(ctx.deps, { ...QUESTION_NOTIFICATION, resource });

    expect(outcome).toEqual({ status: "unroutable_resource" });
    expect(ctx.enqueued).toHaveLength(0);
    expect(ctx.lines.join()).toContain("ml_webhook_unroutable_resource");
  });

  it("ID grande demais para inteiro seguro é recusado, nunca truncado em silêncio", async () => {
    const ctx = deps();

    const outcome = await receiveWebhook(ctx.deps, {
      ...QUESTION_NOTIFICATION,
      resource: "/questions/999999999999999999999999",
    });

    expect(outcome).toEqual({ status: "unroutable_resource" });
    expect(ctx.enqueued).toHaveLength(0);
  });

  it.each(["orders_v2", "post_purchase", "items", "shipments"])(
    "tópico vizinho %s continua indo para sync.webhook.received, sem regressão",
    async (topic) => {
      const ctx = deps();

      const outcome = await receiveWebhook(ctx.deps, {
        ...NOTIFICATION,
        topic,
        resource: "/orders/2000003508426396",
      });

      expect(outcome).toMatchObject({ status: "enqueued", jobType: "sync.webhook.received" });
      expect(ctx.enqueued[0]?.jobType).toBe("sync.webhook.received");
      expect(ctx.enqueued[0]?.payload).toMatchObject({ topic, mlAccountId: ACCOUNT.id });
    },
  );

  it("mensagem NÃO cai mais no caminho genérico — tem job próprio agora", async () => {
    const ctx = deps();

    const outcome = await receiveWebhook(ctx.deps, {
      ...NOTIFICATION,
      topic: "messages",
      resource: "fd1d2e37ad004ede9e0bf25d1215002d",
    });

    expect(outcome).toMatchObject({ status: "enqueued", jobType: "sync.support.messages" });
    expect(ctx.enqueued[0]?.payload).toMatchObject({
      messageId: "fd1d2e37ad004ede9e0bf25d1215002d",
      mlAccountId: ACCOUNT.id,
    });
  });

  it("recusa resource de mensagem com barra: o tópico entrega o ID CRU", async () => {
    const ctx = deps();

    const outcome = await receiveWebhook(ctx.deps, {
      ...NOTIFICATION,
      topic: "messages",
      resource: "/messages/fd1d2e37ad004ede9e0bf25d1215002d",
    });

    expect(outcome).toEqual({ status: "unroutable_resource" });
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("aviso de leitura não gasta um GET do pool de 500 rpm da mensageria", async () => {
    const ctx = deps();

    const outcome = await receiveWebhook(ctx.deps, {
      ...NOTIFICATION,
      topic: "messages",
      resource: "fd1d2e37ad004ede9e0bf25d1215002d",
      actions: ["read"],
    });

    expect(outcome).toEqual({ status: "ignored_action" });
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("mensagem nova continua entrando quando `created` acompanha `read`", async () => {
    const ctx = deps();

    const outcome = await receiveWebhook(ctx.deps, {
      ...NOTIFICATION,
      topic: "messages",
      resource: "fd1d2e37ad004ede9e0bf25d1215002d",
      actions: ["read", "created"],
    });

    expect(outcome).toMatchObject({ status: "enqueued", jobType: "sync.support.messages" });
  });

  it("conta desconhecida continua vencendo o roteamento por tópico — nada é enfileirado", async () => {
    const ctx = deps({ accountExists: false });

    const outcome = await receiveWebhook(ctx.deps, QUESTION_NOTIFICATION);

    expect(outcome).toEqual({ status: "unknown_account" });
    expect(ctx.enqueued).toHaveLength(0);
  });
});
