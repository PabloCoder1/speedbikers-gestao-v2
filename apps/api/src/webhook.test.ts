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
    // `post_purchase` em vez de `items`: desde D-179 tópico sem consumidor
    // nem chega à fila, e a afirmação aqui é sobre a CHAVE não depender do
    // tópico — o que continua valendo entre dois tópicos enfileiráveis.
    await receiveWebhook(ctx.deps, { ...NOTIFICATION, topic: "post_purchase", _id: "not-2" });

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

  it.each(["orders_v2", "post_purchase"])(
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

  /**
   * D-179 — o ponto da fatia: tópico sem consumidor recebe ACK e NÃO vira
   * Cloud Task. Medido antes da mudança: 218.750 execuções de
   * `sync.webhook.received` que terminaram `done / processed: 0`, cada uma
   * tendo custado task + invocação de worker + linha de `job_runs`.
   */
  it.each(["shipments", "items", "user-products", "collections", "seller-promotions", "stock-location"])(
    "tópico %s não tem consumidor: ACK sem enfileirar nada",
    async (topic) => {
      const ctx = deps();

      const outcome = await receiveWebhook(ctx.deps, {
        ...NOTIFICATION,
        topic,
        resource: "/items/MLB1054990648",
      });

      expect(outcome).toEqual({ status: "no_consumer", topic });
      // O que esta fatia existe para impedir:
      expect(ctx.enqueued).toHaveLength(0);
    },
  );

  it("tópico sem consumidor continua observável — o log estruturado sai no lugar do job", async () => {
    const registros: { event: string; fields: Record<string, unknown> }[] = [];
    const ctx = deps();

    ctx.deps.logger = {
      ...ctx.deps.logger,
      info: (event: string, fields: Record<string, unknown>) => {
        registros.push({ event, fields });
      },
    } as typeof ctx.deps.logger;

    await receiveWebhook(ctx.deps, {
      ...NOTIFICATION,
      topic: "shipments",
      resource: "/shipments/44556677",
    });

    const registro = registros.find((r) => r.event === "ml_webhook_topic_without_consumer");

    expect(registro?.fields).toMatchObject({ topic: "shipments", resource: "/shipments/44556677" });
  });

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

/**
 * D-343 — de onde vem o ACK lento. D-339 mediu o ACK passando de 7 s no pico e
 * D-340 desfez a correção que esfriou as conexões; a próxima só se escolhe
 * sabendo quanto de cada requisição é a consulta da conta no Postgres e quanto
 * é a criação da Cloud Task. Os campos só ACRESCENTAM ao log: nenhum I/O muda.
 */
describe("receiveWebhook — tempo do ACK por etapa (D-343)", () => {
  /** Relógio que devolve os instantes na ordem em que forem pedidos. */
  function relogio(instantes: number[]): () => number {
    const fila = [...instantes];

    return () => {
      const proximo = fila.shift();

      if (proximo === undefined) {
        throw new Error("o relógio foi consultado mais vezes do que o teste previa");
      }

      return proximo;
    };
  }

  function registrosDe(ctx: ReturnType<typeof deps>): { event: string; fields: Record<string, unknown> }[] {
    const registros: { event: string; fields: Record<string, unknown> }[] = [];
    const registrar = (event: string, fields: Record<string, unknown>) => {
      registros.push({ event, fields });
    };

    ctx.deps.logger = { ...ctx.deps.logger, info: registrar, warn: registrar } as typeof ctx.deps.logger;

    return registros;
  }

  it("enfileirado: o log separa a consulta da conta e a Cloud Task", async () => {
    const ctx = deps();
    const registros = registrosDe(ctx);
    // antes da conta, depois da conta, antes da task, depois da task
    ctx.deps.monotonicNow = relogio([1000, 1042.4, 1043, 1206.6]);

    await receiveWebhook(ctx.deps, NOTIFICATION);

    const registro = registros.find((r) => r.event === "ml_webhook_enqueued");

    expect(registro?.fields).toMatchObject({ lookup_ms: 42, enqueue_ms: 164 });
  });

  it("tópico sem consumidor: só há consulta da conta, e o log a mede", async () => {
    const ctx = deps();
    const registros = registrosDe(ctx);
    ctx.deps.monotonicNow = relogio([500, 537]);

    await receiveWebhook(ctx.deps, { ...NOTIFICATION, topic: "shipments", resource: "/shipments/44556677" });

    const registro = registros.find((r) => r.event === "ml_webhook_topic_without_consumer");

    expect(registro?.fields).toMatchObject({ lookup_ms: 37 });
    expect(registro?.fields).not.toHaveProperty("enqueue_ms");
  });

  it("conta desconhecida também leva o tempo da consulta — foi ela que custou", async () => {
    const ctx = deps({ accountExists: false });
    const registros = registrosDe(ctx);
    ctx.deps.monotonicNow = relogio([0, 12]);

    await receiveWebhook(ctx.deps, NOTIFICATION);

    expect(registros.find((r) => r.event === "ml_webhook_unknown_account")?.fields).toMatchObject({ lookup_ms: 12 });
  });

  it("payload inválido não consulta o relógio: não há etapa a medir", async () => {
    const ctx = deps();
    ctx.deps.monotonicNow = relogio([]);

    await expect(receiveWebhook(ctx.deps, { topic: "orders_v2" })).resolves.toMatchObject({ status: "invalid_payload" });
  });

  it("sem relógio injetado, os campos saem como milissegundos inteiros não negativos", async () => {
    const ctx = deps();
    const registros = registrosDe(ctx);

    await receiveWebhook(ctx.deps, NOTIFICATION);

    const campos = registros.find((r) => r.event === "ml_webhook_enqueued")?.fields ?? {};

    for (const campo of ["lookup_ms", "enqueue_ms"]) {
      expect(Number.isInteger(campos[campo])).toBe(true);
      expect(campos[campo] as number).toBeGreaterThanOrEqual(0);
    }
  });
});

/**
 * D-346 — a conta vem da memória. D-345 mediu, na rajada de 14/09, a consulta
 * por notificação custando p95 de 2,8 s e explicando o ACK sozinha. Com o
 * diretório, nenhum caminho do ACK toca o banco — nem o com trabalho, que é o
 * que D-340 esfriou ao tirar a consulta só do sem consumidor.
 */
describe("receiveWebhook — contas em memória (D-346)", () => {
  function dbQueExplode(): WebhookDeps["db"] {
    return {
      from: () => {
        throw new Error("consultou o banco");
      },
    } as unknown as WebhookDeps["db"];
  }

  function comDiretorio(conhecido: number | null): ReturnType<typeof deps> {
    const ctx = deps();
    ctx.deps.db = dbQueExplode();
    ctx.deps.accounts = {
      resolve: (sellerId) => Promise.resolve(sellerId === conhecido ? ACCOUNT : null),
    };

    return ctx;
  }

  it("enfileirado: resolve a conta pelo diretório e não consulta o banco", async () => {
    const ctx = comDiretorio(NOTIFICATION.user_id);

    const outcome = await receiveWebhook(ctx.deps, NOTIFICATION);

    expect(outcome).toMatchObject({ status: "enqueued" });
    expect(ctx.enqueued[0]).toMatchObject({
      organizationId: ACCOUNT.organization_id,
      queue: `ml-sync-${ACCOUNT.slug}`,
      payload: { mlAccountId: ACCOUNT.id },
    });
  });

  it("tópico sem consumidor também resolve pelo diretório, sem banco", async () => {
    const ctx = comDiretorio(NOTIFICATION.user_id);

    const outcome = await receiveWebhook(ctx.deps, { ...NOTIFICATION, topic: "stock-locations", resource: "/x" });

    expect(outcome).toEqual({ status: "no_consumer", topic: "stock-locations" });
  });

  it("seller que o diretório não conhece: conta desconhecida, sem enfileirar", async () => {
    const ctx = comDiretorio(null);

    const outcome = await receiveWebhook(ctx.deps, NOTIFICATION);

    expect(outcome).toEqual({ status: "unknown_account" });
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("diretório que rejeita (banco fora, nada em memória): ACK como conta desconhecida, com o motivo no log", async () => {
    const ctx = deps();
    const avisos: { event: string; fields: Record<string, unknown> }[] = [];
    ctx.deps.db = dbQueExplode();
    ctx.deps.accounts = { resolve: () => Promise.reject(new Error("falha ao carregar ml_accounts: timeout")) };
    ctx.deps.logger = {
      ...ctx.deps.logger,
      warn: (event: string, fields: Record<string, unknown>) => {
        avisos.push({ event, fields });
      },
    } as typeof ctx.deps.logger;

    const outcome = await receiveWebhook(ctx.deps, NOTIFICATION);

    expect(outcome).toEqual({ status: "unknown_account" });
    expect(avisos.find((a) => a.event === "ml_webhook_unknown_account")?.fields).toMatchObject({
      lookup_error: "falha ao carregar ml_accounts: timeout",
    });
  });
});
