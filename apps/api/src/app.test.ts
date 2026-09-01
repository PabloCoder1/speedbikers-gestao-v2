import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import type { AuthResult, Caller, Role } from "./auth.js";
import type { EnqueueRequest } from "./enqueue.js";
import type { FulfillmentScheduleDeps } from "./fulfillment-schedule.js";
import { createIpAllowlistVerifier } from "./ip-allowlist.js";
import type { LedgerIntegrityScheduleDeps } from "./ledger-integrity-schedule.js";
import type { ListingVisitsScheduleDeps } from "./listing-visits-schedule.js";
import type { ListingsScheduleDeps } from "./listings-schedule.js";
import type { MlAccountsDeps } from "./ml-accounts.js";
import type { OidcVerifier } from "./oidc.js";
import type { ReconcileDeps } from "./reconcile.js";
import type { WebhookDeps } from "./webhook.js";

function buildApp(): { app: ReturnType<typeof createApp>; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({}, { sink: (line) => lines.push(line) });

  return { app: createApp({ logger, startedAt: new Date("2026-08-19T14:00:00.000Z") }), lines };
}

describe("GET /health", () => {
  it("responde 200 com o estado do serviço", async () => {
    const { app } = buildApp();

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "api",
      startedAt: "2026-08-19T14:00:00.000Z",
      // `null` sem APP_COMMIT no ambiente (D-176): a Saude do Sistema le
      // isso como UNKNOWN e diz o motivo, em vez de fingir um commit.
      commit: null,
    });
  });

  it("expõe o commit implantado quando APP_COMMIT existe (D-176)", async () => {
    const anterior = process.env.APP_COMMIT;
    process.env.APP_COMMIT = "abc1234";

    try {
      const { app } = buildApp();
      const response = await app.request("/health");

      expect(await response.json()).toMatchObject({ commit: "abc1234" });
    } finally {
      if (anterior === undefined) {
        delete process.env.APP_COMMIT;
      } else {
        process.env.APP_COMMIT = anterior;
      }
    }
  });

  it("não exige autenticação — o Cloud Run precisa dele para o probe", async () => {
    const { app } = buildApp();

    expect((await app.request("/health")).status).toBe(200);
  });
});

describe("request id", () => {
  it("gera um id quando o cliente não envia", async () => {
    const { app } = buildApp();

    const requestId = (await app.request("/health")).headers.get("x-request-id");

    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("preserva o id enviado pelo cliente, para correlacionar ponta a ponta", async () => {
    const { app } = buildApp();

    const response = await app.request("/health", {
      headers: { "x-request-id": "trace-123" },
    });

    expect(response.headers.get("x-request-id")).toBe("trace-123");
  });
});

describe("rota inexistente", () => {
  it("responde 404 no formato de erro padrão", async () => {
    const { app } = buildApp();

    const response = await app.request("/nao-existe");
    const body = (await response.json()) as { error: Record<string, unknown> };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
    expect(body.error.request_id).toBeTypeOf("string");
  });
});

describe("erro não tratado", () => {
  it("responde 500 sem vazar detalhe interno e registra o erro", async () => {
    const { app, lines } = buildApp();

    app.get("/explode", () => {
      throw new Error("connection string: postgres://user:senha@host");
    });

    const response = await app.request("/explode");
    const raw = await response.text();

    expect(response.status).toBe(500);
    expect(raw).not.toContain("postgres://");
    expect(raw).not.toContain("senha");

    expect(lines.join()).toContain("unhandled_request_error");
  });
});


describe("rotas /internal", () => {
  function withOidc(oidc: OidcVerifier): ReturnType<typeof buildApp> {
    const lines: string[] = [];
    const logger = createLogger({}, { sink: (line) => lines.push(line) });

    return { app: createApp({ logger, oidc }), lines };
  }

  const aceitaTudo: OidcVerifier = {
    verify: () => Promise.resolve({ ok: true, email: "quem@exemplo.com" }),
  };

  const recusaTudo: OidcVerifier = {
    verify: () => Promise.resolve({ ok: false, reason: "token inválido" }),
  };

  it("recusa com 401 quando o token não verifica", async () => {
    const { app } = withOidc(recusaTudo);

    const response = await app.request("/internal/jobs/ping", { method: "POST" });

    expect(response.status).toBe(401);
  });

  it("não revela ao chamador o motivo exato da recusa", async () => {
    const { app } = withOidc(recusaTudo);

    const raw = await (await app.request("/internal/jobs/ping", { method: "POST" })).text();

    expect(raw).not.toContain("token inválido");
    expect(raw).toContain("unauthorized");
  });

  it("registra a recusa no log, com o motivo", async () => {
    const { app, lines } = withOidc(recusaTudo);

    await app.request("/internal/jobs/ping", { method: "POST" });

    expect(lines.join()).toContain("internal_auth_rejected");
    expect(lines.join()).toContain("token inválido");
  });

  it("responde 503 quando o OIDC não está configurado", async () => {
    const { app } = buildApp();

    expect((await app.request("/internal/jobs/ping", { method: "POST" })).status).toBe(503);
  });

  it("passa da autenticação mas responde 503 sem enfileirador", async () => {
    const { app } = withOidc(aceitaTudo);

    expect((await app.request("/internal/jobs/ping", { method: "POST" })).status).toBe(503);
  });

  it("enfileira e devolve o resultado quando tudo está configurado", async () => {
    const lines: string[] = [];
    const logger = createLogger({}, { sink: (line) => lines.push(line) });

    const app = createApp({
      logger,
      oidc: aceitaTudo,
      enqueuer: {
        enqueue: () =>
          Promise.resolve({
            taskName: "projects/p/locations/l/queues/maintenance/tasks/ping-2026-08-20T12-00",
            deduplicated: true,
            envelope: {
              jobType: "system.ping",
              jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
              organizationId: "00000000-0000-4000-8000-000000000000",
              dedupeKey: "ping:2026-08-20T12:00",
              attempt: 1,
              enqueuedAt: "2026-08-20T12:00:00.000Z",
            },
          }),
      },
    });

    const response = await app.request("/internal/jobs/ping", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enqueued: true, deduplicated: true });
    expect(lines.join()).toContain("job_enqueued");
  });

  it("/health continua público — o middleware só cobre /internal", async () => {
    const { app } = withOidc(recusaTudo);

    expect((await app.request("/health")).status).toBe(200);
  });
});

describe("POST /internal/schedule/reconcile", () => {
  const aceitaTudo: OidcVerifier = {
    verify: () => Promise.resolve({ ok: true, email: "scheduler@exemplo.com" }),
  };

  const recusaTudo: OidcVerifier = {
    verify: () => Promise.resolve({ ok: false, reason: "token inválido" }),
  };

  function fakeReconcileDb(): ReconcileDeps["db"] {
    return {
      from: () => ({
        select: () => ({
          eq: () =>
            Promise.resolve({
              data: [{ id: "acc-1", organization_id: "org-1", slug: "speedbikers-loja-1" }],
              error: null,
            }),
        }),
      }),
    } as unknown as ReconcileDeps["db"];
  }

  it("exige OIDC, como as demais rotas /internal", async () => {
    const app = createApp({ logger: createLogger({}, { sink: () => undefined }), oidc: recusaTudo });

    const response = await app.request("/internal/schedule/reconcile", { method: "POST" });

    expect(response.status).toBe(401);
  });

  it("responde 503 sem as dependências de reconciliação", async () => {
    const app = createApp({ logger: createLogger({}, { sink: () => undefined }), oidc: aceitaTudo });

    const response = await app.request("/internal/schedule/reconcile", { method: "POST" });

    expect(response.status).toBe(503);
  });

  it("dispara a reconciliação e devolve o resumo", async () => {
    const enqueued: EnqueueRequest[] = [];

    const app = createApp({
      logger: createLogger({}, { sink: () => undefined }),
      oidc: aceitaTudo,
      reconcile: {
        db: fakeReconcileDb(),
        logger: createLogger({}, { sink: () => undefined }),
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
                enqueuedAt: "2026-08-21T15:00:00.000Z",
              },
            });
          },
        },
      },
    });

    const response = await app.request("/internal/schedule/reconcile", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accountsScanned: 1, enqueued: 1, deduplicated: 0 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.queue).toBe("ml-sync-speedbikers-loja-1");
  });
});

describe("POST /internal/schedule/fulfillment", () => {
  const aceitaTudo: OidcVerifier = {
    verify: () => Promise.resolve({ ok: true, email: "scheduler@exemplo.com" }),
  };

  const recusaTudo: OidcVerifier = {
    verify: () => Promise.resolve({ ok: false, reason: "token inválido" }),
  };

  function fakeFulfillmentDb(): FulfillmentScheduleDeps["db"] {
    return {
      from: () => ({
        select: () => ({
          eq: () =>
            Promise.resolve({
              data: [{ id: "acc-1", organization_id: "org-1", slug: "speedbikers-loja-1" }],
              error: null,
            }),
        }),
      }),
    } as unknown as FulfillmentScheduleDeps["db"];
  }

  it("exige OIDC, como as demais rotas /internal", async () => {
    const app = createApp({ logger: createLogger({}, { sink: () => undefined }), oidc: recusaTudo });

    const response = await app.request("/internal/schedule/fulfillment", { method: "POST" });

    expect(response.status).toBe(401);
  });

  it("responde 503 sem as dependências de captura do Full", async () => {
    const app = createApp({ logger: createLogger({}, { sink: () => undefined }), oidc: aceitaTudo });

    const response = await app.request("/internal/schedule/fulfillment", { method: "POST" });

    expect(response.status).toBe(503);
  });

  it("dispara a captura e devolve o resumo", async () => {
    const enqueued: EnqueueRequest[] = [];

    const app = createApp({
      logger: createLogger({}, { sink: () => undefined }),
      oidc: aceitaTudo,
      fulfillmentSchedule: {
        db: fakeFulfillmentDb(),
        logger: createLogger({}, { sink: () => undefined }),
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
                enqueuedAt: "2026-08-22T18:00:00.000Z",
              },
            });
          },
        },
      },
    });

    const response = await app.request("/internal/schedule/fulfillment", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accountsScanned: 1, enqueued: 1, deduplicated: 0 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.jobType).toBe("sync.fulfillment.snapshot");
    expect(enqueued[0]?.queue).toBe("ml-sync-speedbikers-loja-1");
  });
});

describe("POST /internal/schedule/ledger-integrity", () => {
  const aceitaTudo: OidcVerifier = {
    verify: () => Promise.resolve({ ok: true, email: "scheduler@exemplo.com" }),
  };

  const recusaTudo: OidcVerifier = {
    verify: () => Promise.resolve({ ok: false, reason: "token inválido" }),
  };

  function fakeOrganizationsDb(): LedgerIntegrityScheduleDeps["db"] {
    return {
      from: () => ({
        select: () => Promise.resolve({ data: [{ id: "org-1" }], error: null }),
      }),
    } as unknown as LedgerIntegrityScheduleDeps["db"];
  }

  it("exige OIDC, como as demais rotas /internal", async () => {
    const app = createApp({ logger: createLogger({}, { sink: () => undefined }), oidc: recusaTudo });

    const response = await app.request("/internal/schedule/ledger-integrity", { method: "POST" });

    expect(response.status).toBe(401);
  });

  it("responde 503 sem as dependências da conferência", async () => {
    const app = createApp({ logger: createLogger({}, { sink: () => undefined }), oidc: aceitaTudo });

    const response = await app.request("/internal/schedule/ledger-integrity", { method: "POST" });

    expect(response.status).toBe(503);
  });

  it("dispara a conferência e devolve o resumo", async () => {
    const enqueued: EnqueueRequest[] = [];

    const app = createApp({
      logger: createLogger({}, { sink: () => undefined }),
      oidc: aceitaTudo,
      ledgerIntegritySchedule: {
        db: fakeOrganizationsDb(),
        logger: createLogger({}, { sink: () => undefined }),
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
                enqueuedAt: "2026-08-23T18:00:00.000Z",
              },
            });
          },
        },
      },
    });

    const response = await app.request("/internal/schedule/ledger-integrity", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ organizationsScanned: 1, enqueued: 1, deduplicated: 0 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.jobType).toBe("maintenance.verify-ledger-integrity");
    expect(enqueued[0]?.queue).toBe("maintenance");
  });
});

describe("POST /internal/schedule/listings", () => {
  const aceitaTudo: OidcVerifier = {
    verify: () => Promise.resolve({ ok: true, email: "scheduler@exemplo.com" }),
  };

  const recusaTudo: OidcVerifier = {
    verify: () => Promise.resolve({ ok: false, reason: "token inválido" }),
  };

  function fakeAccountsDb(): ListingsScheduleDeps["db"] {
    return {
      from: () => ({
        select: () => ({
          eq: () =>
            Promise.resolve({
              data: [{ id: "acc-1", organization_id: "org-1", slug: "speedbikers-loja-1" }],
              error: null,
            }),
        }),
      }),
    } as unknown as ListingsScheduleDeps["db"];
  }

  it("exige OIDC, como as demais rotas /internal", async () => {
    const app = createApp({ logger: createLogger({}, { sink: () => undefined }), oidc: recusaTudo });

    const response = await app.request("/internal/schedule/listings", { method: "POST" });

    expect(response.status).toBe(401);
  });

  it("responde 503 sem as dependências da sincronização", async () => {
    const app = createApp({ logger: createLogger({}, { sink: () => undefined }), oidc: aceitaTudo });

    const response = await app.request("/internal/schedule/listings", { method: "POST" });

    expect(response.status).toBe(503);
  });

  it("dispara a sincronização e devolve o resumo", async () => {
    const enqueued: EnqueueRequest[] = [];

    const app = createApp({
      logger: createLogger({}, { sink: () => undefined }),
      oidc: aceitaTudo,
      listingsSchedule: {
        db: fakeAccountsDb(),
        logger: createLogger({}, { sink: () => undefined }),
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
                enqueuedAt: "2026-08-23T18:00:00.000Z",
              },
            });
          },
        },
      },
    });

    const response = await app.request("/internal/schedule/listings", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accountsScanned: 1, enqueued: 1, deduplicated: 0 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.jobType).toBe("sync.listings.snapshot");
    expect(enqueued[0]?.queue).toBe("ml-sync-speedbikers-loja-1");
  });
});

describe("POST /internal/schedule/listing-visits", () => {
  const aceitaTudo: OidcVerifier = {
    verify: () => Promise.resolve({ ok: true, email: "scheduler@exemplo.com" }),
  };

  const recusaTudo: OidcVerifier = {
    verify: () => Promise.resolve({ ok: false, reason: "token inválido" }),
  };

  function fakeAccountsDb(): ListingVisitsScheduleDeps["db"] {
    return {
      from: () => ({
        select: () => ({
          eq: () =>
            Promise.resolve({
              data: [{ id: "acc-1", organization_id: "org-1", slug: "speedbikers-loja-1" }],
              error: null,
            }),
        }),
      }),
    } as unknown as ListingVisitsScheduleDeps["db"];
  }

  it("exige OIDC, como as demais rotas /internal", async () => {
    const app = createApp({ logger: createLogger({}, { sink: () => undefined }), oidc: recusaTudo });

    const response = await app.request("/internal/schedule/listing-visits", { method: "POST" });

    expect(response.status).toBe(401);
  });

  it("responde 503 sem as dependências da sincronização", async () => {
    const app = createApp({ logger: createLogger({}, { sink: () => undefined }), oidc: aceitaTudo });

    const response = await app.request("/internal/schedule/listing-visits", { method: "POST" });

    expect(response.status).toBe(503);
  });

  it("dispara a sincronização e devolve o resumo", async () => {
    const enqueued: EnqueueRequest[] = [];

    const app = createApp({
      logger: createLogger({}, { sink: () => undefined }),
      oidc: aceitaTudo,
      listingVisitsSchedule: {
        db: fakeAccountsDb(),
        logger: createLogger({}, { sink: () => undefined }),
        enqueuer: {
          enqueue: (request) => {
            enqueued.push(request);

            return Promise.resolve({
              taskName: "t",
              deduplicated: false,
              envelope: {
                jobType: request.jobType,
                jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b22",
                organizationId: request.organizationId,
                dedupeKey: request.dedupeKey,
                attempt: 1,
                enqueuedAt: "2026-08-23T18:00:00.000Z",
              },
            });
          },
        },
      },
    });

    const response = await app.request("/internal/schedule/listing-visits", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accountsScanned: 1, enqueued: 1, deduplicated: 0 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.jobType).toBe("sync.listing-visits.snapshot");
    expect(enqueued[0]?.queue).toBe("ml-sync-speedbikers-loja-1");
  });
});

describe("POST /internal/schedule/support-questions", () => {
  const aceitaTudo: OidcVerifier = {
    verify: () => Promise.resolve({ ok: true, email: "scheduler@exemplo.com" }),
  };

  const recusaTudo: OidcVerifier = {
    verify: () => Promise.resolve({ ok: false, reason: "token inválido" }),
  };

  it("exige OIDC, como as demais rotas /internal — a allowlist do webhook não vale aqui", async () => {
    const app = createApp({ logger: createLogger({}, { sink: () => undefined }), oidc: recusaTudo });

    const response = await app.request("/internal/schedule/support-questions", { method: "POST" });

    expect(response.status).toBe(401);
  });

  it("responde 503 sem as dependências da reconciliação", async () => {
    const app = createApp({ logger: createLogger({}, { sink: () => undefined }), oidc: aceitaTudo });

    const response = await app.request("/internal/schedule/support-questions", { method: "POST" });

    expect(response.status).toBe(503);
  });

  it("dispara a reconciliação e devolve o resumo", async () => {
    const enqueued: EnqueueRequest[] = [];

    const app = createApp({
      logger: createLogger({}, { sink: () => undefined }),
      oidc: aceitaTudo,
      supportQuestionsSchedule: {
        db: {
          from: () => ({
            select: () => ({
              eq: () =>
                Promise.resolve({
                  data: [{ id: "acc-1", organization_id: "org-1", slug: "speedbikers-loja-1" }],
                  error: null,
                }),
            }),
          }),
        } as unknown as ListingVisitsScheduleDeps["db"],
        logger: createLogger({}, { sink: () => undefined }),
        enqueuer: {
          enqueue: (request) => {
            enqueued.push(request);

            return Promise.resolve({
              taskName: "t",
              deduplicated: false,
              envelope: {
                jobType: request.jobType,
                jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b32",
                organizationId: request.organizationId,
                dedupeKey: request.dedupeKey,
                attempt: 1,
                enqueuedAt: "2026-08-25T18:20:00.000Z",
              },
            });
          },
        },
      },
    });

    const response = await app.request("/internal/schedule/support-questions", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accountsScanned: 1, enqueued: 1, deduplicated: 0 });
    expect(enqueued[0]?.jobType).toBe("sync.support.questions.reconcile");
    expect(enqueued[0]?.queue).toBe("ml-sync-speedbikers-loja-1");
  });

  it("responde 503 sem as dependências da reconciliação de mensagens", async () => {
    const app = createApp({ logger: createLogger({}, { sink: () => undefined }), oidc: aceitaTudo });

    const response = await app.request("/internal/schedule/support-messages", { method: "POST" });

    expect(response.status).toBe(503);
  });

  it("dispara a reconciliação de mensagens na fila da conta", async () => {
    const enqueued: EnqueueRequest[] = [];

    const app = createApp({
      logger: createLogger({}, { sink: () => undefined }),
      oidc: aceitaTudo,
      supportMessagesSchedule: {
        db: {
          from: () => ({
            select: () => ({
              eq: () =>
                Promise.resolve({
                  data: [{ id: "acc-1", organization_id: "org-1", slug: "speedbikers-loja-1" }],
                  error: null,
                }),
            }),
          }),
        } as unknown as ListingVisitsScheduleDeps["db"],
        logger: createLogger({}, { sink: () => undefined }),
        enqueuer: {
          enqueue: (request) => {
            enqueued.push(request);

            return Promise.resolve({
              taskName: "t",
              deduplicated: false,
              envelope: {
                jobType: request.jobType,
                jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b33",
                organizationId: request.organizationId,
                dedupeKey: request.dedupeKey,
                attempt: 1,
                enqueuedAt: "2026-08-26T19:20:00.000Z",
              },
            });
          },
        },
      },
    });

    const response = await app.request("/internal/schedule/support-messages", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accountsScanned: 1, enqueued: 1, deduplicated: 0 });
    expect(enqueued[0]?.jobType).toBe("sync.support.messages.reconcile");
    expect(enqueued[0]?.queue).toBe("ml-sync-speedbikers-loja-1");
    expect(enqueued[0]?.dedupeKey).toMatch(/^support-messages:speedbikers-loja-1:/);
  });
});

describe("webhook do Mercado Livre", () => {
  const ALLOWED_IP = "54.88.218.97";
  // Formato REAL do Cloud Run, medido em 2026-08-26 (D-093): o IP confiável é
  // o ÚLTIMO da lista, porque é o que o Cloud Run acrescenta. O cliente
  // controla tudo que vem antes.
  const FORWARDED_ALLOWED = ALLOWED_IP;
  const FORWARDED_DISALLOWED = "203.0.113.10";
  /** Um IP da allowlist FORJADO pelo cliente, com o IP real dele no fim. */
  const FORWARDED_SPOOFED = `${ALLOWED_IP},203.0.113.10`;

  const NOTIFICATION = {
    _id: "not-1",
    resource: "/orders/2000003508426396",
    user_id: 987654321,
    topic: "orders_v2",
  };

  const ACCOUNT = {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    organization_id: "11111111-0000-4000-8000-000000000001",
    slug: "speedbikers-loja-1",
  };

  function fakeWebhookDb(options: { accountExists?: boolean } = {}): WebhookDeps["db"] {
    const accountExists = options.accountExists ?? true;

    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: accountExists ? ACCOUNT : null, error: null }),
          }),
        }),
      }),
    } as unknown as WebhookDeps["db"];
  }

  function withWebhook(options: {
    accountExists?: boolean;
    withIpAllowlist?: boolean;
    withWebhookDeps?: boolean;
  } = {}): { app: ReturnType<typeof createApp>; lines: string[]; enqueued: unknown[] } {
    const lines: string[] = [];
    const enqueued: unknown[] = [];
    const logger = createLogger({}, { sink: (line) => lines.push(line) });

    const app = createApp({
      logger,
      ...(options.withIpAllowlist === false ? {} : { ipAllowlist: createIpAllowlistVerifier() }),
      ...(options.withWebhookDeps === false
        ? {}
        : {
            webhook: {
              db: fakeWebhookDb(options),
              logger,
              enqueuer: {
                enqueue: (request: EnqueueRequest) => {
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
          }),
    });

    return { app, lines, enqueued };
  }

  it("aceita a notificação de um IP da allowlist, SEM Authorization nenhum", async () => {
    const { app, enqueued } = withWebhook();

    const response = await app.request("/webhooks/mercado-livre", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": FORWARDED_ALLOWED },
      body: JSON.stringify(NOTIFICATION),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, processed: true });
    expect(enqueued).toHaveLength(1);
  });

  it("recusa com 403 uma origem fora da allowlist, e não enfileira nada", async () => {
    const { app, lines, enqueued } = withWebhook();

    const response = await app.request("/webhooks/mercado-livre", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": FORWARDED_DISALLOWED },
      body: JSON.stringify(NOTIFICATION),
    });

    expect(response.status).toBe(403);
    expect(enqueued).toHaveLength(0);
    expect(lines.join()).toContain("webhook_origin_rejected");
  });

  it("REGRESSÃO DE SEGURANÇA: IP da allowlist forjado pelo cliente é recusado (D-093)", async () => {
    // Até 2026-08-26 esta chamada era ACEITA em produção com status 200: a
    // extração pegava o penúltimo elemento, que é justamente o que o cliente
    // consegue escrever. Verificado contra o serviço real.
    const { app, enqueued } = withWebhook();

    const response = await app.request("/webhooks/mercado-livre", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": FORWARDED_SPOOFED },
      body: JSON.stringify(NOTIFICATION),
    });

    expect(response.status).toBe(403);
    expect(enqueued).toHaveLength(0);
  });

  it("recusa quando não há X-Forwarded-For nenhum", async () => {
    const { app } = withWebhook();

    const response = await app.request("/webhooks/mercado-livre", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(NOTIFICATION),
    });

    expect(response.status).toBe(403);
  });

  it("responde 503 quando a allowlist de IP não está configurada", async () => {
    const { app } = withWebhook({ withIpAllowlist: false });

    const response = await app.request("/webhooks/mercado-livre", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": FORWARDED_ALLOWED },
      body: JSON.stringify(NOTIFICATION),
    });

    expect(response.status).toBe(503);
  });

  it("passa da allowlist de IP mas responde 503 sem as dependências do webhook", async () => {
    const { app } = withWebhook({ withWebhookDeps: false });

    const response = await app.request("/webhooks/mercado-livre", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": FORWARDED_ALLOWED },
      body: JSON.stringify(NOTIFICATION),
    });

    expect(response.status).toBe(503);
  });

  it("corpo que não é JSON responde 400, não 500", async () => {
    const { app } = withWebhook();

    const response = await app.request("/webhooks/mercado-livre", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": FORWARDED_ALLOWED },
      body: "isto nao e json",
    });

    expect(response.status).toBe(400);
  });

  it("payload que não bate o schema responde 400", async () => {
    const { app, enqueued } = withWebhook();

    const response = await app.request("/webhooks/mercado-livre", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": FORWARDED_ALLOWED },
      body: JSON.stringify({ topic: "orders_v2" }),
    });

    expect(response.status).toBe(400);
    expect(enqueued).toHaveLength(0);
  });

  it("conta desconhecida responde 200 (não vale a pena o ML repetir), mas não enfileira", async () => {
    const { app, enqueued } = withWebhook({ accountExists: false });

    const response = await app.request("/webhooks/mercado-livre", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": FORWARDED_ALLOWED },
      body: JSON.stringify(NOTIFICATION),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, processed: false });
    expect(enqueued).toHaveLength(0);
  });

  it("notificação do tópico questions atravessa a rota e vira sync.support.questions", async () => {
    const { app, enqueued } = withWebhook();

    const response = await app.request("/webhooks/mercado-livre", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": FORWARDED_ALLOWED },
      body: JSON.stringify({ ...NOTIFICATION, topic: "questions", resource: "/questions/12345678901" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, processed: true });
    expect(enqueued).toMatchObject([
      { jobType: "sync.support.questions", payload: { questionId: 12345678901 } },
    ]);
  });

  it("questions com resource fora do formato responde 200 sem enfileirar — ACK rápido, sem retry do ML", async () => {
    const { app, enqueued } = withWebhook();

    const response = await app.request("/webhooks/mercado-livre", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": FORWARDED_ALLOWED },
      body: JSON.stringify({ ...NOTIFICATION, topic: "questions", resource: "/questions/nao-numerico" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, processed: false });
    expect(enqueued).toHaveLength(0);
  });

  it("rota vizinha dentro do próprio namespace (/webhooks/outra-coisa) continua 404", async () => {
    const { app } = withWebhook();

    const response = await app.request("/webhooks/outra-coisa", {
      method: "POST",
      headers: { "x-forwarded-for": FORWARDED_ALLOWED },
    });

    expect(response.status).toBe(404);
  });

  it("a allowlist de IP do webhook NÃO vaza para /internal — Cloud Tasks continua exigindo OIDC", async () => {
    const lines: string[] = [];
    const logger = createLogger({}, { sink: (line) => lines.push(line) });

    const app = createApp({
      logger,
      ipAllowlist: createIpAllowlistVerifier(),
      oidc: { verify: () => Promise.resolve({ ok: false, reason: "sem token" }) },
    });

    // Mesmo vindo de um IP da allowlist do Mercado Livre, /internal não é o
    // webhook — continua exigindo o próprio OIDC.
    const response = await app.request("/internal/jobs/ping", {
      method: "POST",
      headers: { "x-forwarded-for": FORWARDED_ALLOWED },
    });

    expect(response.status).toBe(401);
  });

  it("a allowlist de IP do webhook NÃO vaza para /v1 — upload continua exigindo JWT", async () => {
    const app = createApp({
      logger: createLogger({}, { sink: () => undefined }),
      ipAllowlist: createIpAllowlistVerifier(),
      auth: { authenticate: () => Promise.resolve({ ok: false, status: 401, reason: "sem token" }) },
      // Presente só para passar da checagem de "not_configured" e provar que
      // quem barra a chamada é a autenticação — não a ausência de dependência.
      importDeps: { db: {} as never, store: { upload: () => Promise.resolve() }, enqueuer: { enqueue: () => Promise.reject(new Error("não deveria ser chamado")) }, logger: createLogger({}, { sink: () => undefined }) },
    });

    const response = await app.request("/v1/erp-imports", {
      method: "POST",
      headers: { "x-forwarded-for": FORWARDED_ALLOWED },
    });

    expect(response.status).toBe(401);
  });

  it("não libera CORS no webhook — Mercado Livre não é navegador", async () => {
    const app = createApp({
      logger: createLogger({}, { sink: () => undefined }),
      webOrigins: ["https://gestao.speedbikers.com.br"],
      ipAllowlist: createIpAllowlistVerifier(),
    });

    const response = await app.request("/webhooks/mercado-livre", {
      method: "OPTIONS",
      headers: {
        origin: "https://gestao.speedbikers.com.br",
        "access-control-request-method": "POST",
      },
    });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("CORS de /v1", () => {
  const ORIGIN = "https://gestao.speedbikers.com.br";

  function corsApp(): ReturnType<typeof createApp> {
    return createApp({ logger: createLogger({}, { sink: () => undefined }), webOrigins: [ORIGIN] });
  }

  it("libera a origem que está na lista", async () => {
    const response = await corsApp().request("/v1/erp-imports", {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST" },
    });

    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("não libera origem de fora da lista", async () => {
    const response = await corsApp().request("/v1/erp-imports", {
      method: "OPTIONS",
      headers: { origin: "https://site-de-terceiro.com", "access-control-request-method": "POST" },
    });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("não libera CORS nas rotas internas", async () => {
    // Cloud Tasks e Scheduler não são navegador. Liberar origem aqui só
    // ampliaria a superfície de ataque sem serventia nenhuma.
    const response = await corsApp().request("/internal/jobs/system.ping", {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST" },
    });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("sem origem configurada, nenhum navegador é liberado", async () => {
    const app = createApp({ logger: createLogger({}, { sink: () => undefined }) });

    const response = await app.request("/v1/erp-imports", {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST" },
    });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("conexão de conta Mercado Livre", () => {
  const OAUTH_CONFIG = {
    clientId: "APP_ID_123",
    clientSecret: "segredo-de-teste",
    redirectUri: "https://api.speedbikers.example/oauth/mercado-livre/callback",
  };

  const ENCRYPTION_KEY = randomBytes(32);
  const CODE_VERIFIER_CIPHERTEXT = encryptToken("A".repeat(43), ENCRYPTION_KEY);

  /** Mesmo espírito do `chain` de `ml-accounts.test.ts`: fake mínimo, encadeável e thenable. */
  function chain<T>(result: T): {
    eq: () => ReturnType<typeof chain<T>>;
    is: () => ReturnType<typeof chain<T>>;
    gt: () => ReturnType<typeof chain<T>>;
    select: () => ReturnType<typeof chain<T>>;
    maybeSingle: () => Promise<T>;
    then: <R>(resolve: (value: T) => R) => Promise<R>;
  } {
    const self = {
      eq: () => self,
      is: () => self,
      gt: () => self,
      select: () => self,
      maybeSingle: () => Promise.resolve(result),
      then: <R>(resolve: (value: T) => R) => Promise.resolve(result).then(resolve),
    };

    return self;
  }

  function fakeMlAccountsDb(options: {
    accountStatus?: string | null;
    claimedState?: {
      organization_id: string;
      ml_account_id: string;
      code_verifier_ciphertext: string | null;
    } | null;
  } = {}): MlAccountsDeps["db"] {
    const accountStatus = "accountStatus" in options ? options.accountStatus : "PENDING";
    const claimedState =
      options.claimedState === undefined
        ? {
            organization_id: "org-1",
            ml_account_id: "acc-1",
            code_verifier_ciphertext: CODE_VERIFIER_CIPHERTEXT,
          }
        : options.claimedState;

    return {
      from: (table: string) => ({
        select: () =>
          chain(accountStatus === null ? { data: null, error: null } : { data: { id: "acc-1", status: accountStatus }, error: null }),
        insert: () => chain({ data: null, error: null }),
        update: () => {
          if (table === "ml_oauth_states") {
            return chain(claimedState === null ? { data: null, error: null } : { data: claimedState, error: null });
          }

          return chain({ data: { slug: "acc-1" }, error: null });
        },
        upsert: () => chain({ data: null, error: null }),
      }),
    } as unknown as MlAccountsDeps["db"];
  }

  function withMlAccounts(options: {
    accountStatus?: string | null;
    claimedState?: {
      organization_id: string;
      ml_account_id: string;
      code_verifier_ciphertext: string | null;
    } | null;
    role?: Role;
    withAuth?: boolean;
    withDeps?: boolean;
    fetchImpl?: typeof fetch;
  } = {}): ReturnType<typeof createApp> {
    const authenticate = (
      _header: string | undefined,
      allowed: readonly Role[],
    ): Promise<AuthResult> => {
      if (options.withAuth === false) {
        return Promise.resolve({ ok: false, status: 401, reason: "sem token" });
      }

      const role = options.role ?? "ADMIN";

      if (!allowed.includes(role)) {
        return Promise.resolve({ ok: false, status: 403, reason: "papel sem permissão para esta ação" });
      }

      return Promise.resolve({ ok: true, caller: { userId: "u1", organizationId: "org-1", role } });
    };

    return createApp({
      logger: createLogger({}, { sink: () => undefined }),
      auth: { authenticate },
      ...(options.withDeps === false
        ? {}
        : {
            mlAccounts: {
              db: fakeMlAccountsDb(options),
              oauth: OAUTH_CONFIG,
              encryptionKey: ENCRYPTION_KEY,
              logger: createLogger({}, { sink: () => undefined }),
              enqueuer: {
                enqueue: (request) =>
                  Promise.resolve({
                    taskName: "t",
                    deduplicated: false,
                    envelope: {
                      jobType: request.jobType,
                      jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
                      organizationId: request.organizationId,
                      dedupeKey: request.dedupeKey,
                      attempt: 1,
                      enqueuedAt: "2026-08-21T15:00:00.000Z",
                    },
                  }),
              },
              requestOptions: {
                fetchImpl:
                  options.fetchImpl ??
                  (() =>
                    Promise.resolve(
                      new Response(
                        JSON.stringify({
                          access_token: "APP_USR-token",
                          token_type: "bearer",
                          expires_in: 21_600,
                          scope: "offline_access read write",
                          user_id: 987654321,
                          refresh_token: "TG-refresh",
                        }),
                        { status: 200, headers: { "content-type": "application/json" } },
                      ),
                    )),
              },
            },
          }),
    });
  }

  describe("POST /v1/ml-accounts/connect", () => {
    it("exige ADMIN — GESTOR é recusado", async () => {
      const app = withMlAccounts({ role: "GESTOR" });

      const response = await app.request("/v1/ml-accounts/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mlAccountId: "acc-1" }),
      });

      expect(response.status).toBe(403);
    });

    it("recusa sem autenticação", async () => {
      const app = withMlAccounts({ withAuth: false });

      const response = await app.request("/v1/ml-accounts/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mlAccountId: "acc-1" }),
      });

      expect(response.status).toBe(401);
    });

    it("responde 503 sem as dependências configuradas", async () => {
      const app = withMlAccounts({ withDeps: false });

      const response = await app.request("/v1/ml-accounts/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mlAccountId: "acc-1" }),
      });

      expect(response.status).toBe(503);
    });

    it("responde 400 sem mlAccountId no corpo", async () => {
      const app = withMlAccounts();

      const response = await app.request("/v1/ml-accounts/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });

    it("responde 404 quando a conta não existe", async () => {
      const app = withMlAccounts({ accountStatus: null });

      const response = await app.request("/v1/ml-accounts/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mlAccountId: "acc-inexistente" }),
      });

      expect(response.status).toBe(404);
    });

    it("responde 409 quando a conta já está CONNECTED", async () => {
      const app = withMlAccounts({ accountStatus: "CONNECTED" });

      const response = await app.request("/v1/ml-accounts/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mlAccountId: "acc-1" }),
      });

      expect(response.status).toBe(409);
    });

    it("devolve a authorizationUrl quando tudo está certo", async () => {
      const app = withMlAccounts();

      const response = await app.request("/v1/ml-accounts/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mlAccountId: "acc-1" }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { authorizationUrl: string };
      expect(new URL(body.authorizationUrl).origin).toBe("https://auth.mercadolivre.com.br");
    });
  });

  describe("GET /oauth/mercado-livre/callback", () => {
    it("responde 503 sem as dependências configuradas", async () => {
      const app = withMlAccounts({ withDeps: false });

      expect((await app.request("/oauth/mercado-livre/callback?state=s&code=c")).status).toBe(503);
    });

    it("responde 400 sem state", async () => {
      const app = withMlAccounts();

      expect((await app.request("/oauth/mercado-livre/callback?code=c")).status).toBe(400);
    });

    it("responde 400 quando o state é desconhecido, expirado ou já consumido", async () => {
      const app = withMlAccounts({ claimedState: null });

      const response = await app.request("/oauth/mercado-livre/callback?state=s&code=c");

      expect(response.status).toBe(400);
      expect((await response.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "invalid_state" },
      });
    });

    it("responde 400 quando o Mercado Livre nega a autorização", async () => {
      const app = withMlAccounts();

      const response = await app.request("/oauth/mercado-livre/callback?state=s&error=access_denied");

      expect(response.status).toBe(400);
    });

    it("conclui a conexão e devolve 200", async () => {
      const app = withMlAccounts();

      const response = await app.request("/oauth/mercado-livre/callback?state=s&code=c");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ connected: true, mlAccountId: "acc-1" });
    });

    it("não exige Authorization — quem chega aqui é o navegador do ADMIN, sem sessão desta chamada", async () => {
      const app = withMlAccounts({ withAuth: false });

      const response = await app.request("/oauth/mercado-livre/callback?state=s&code=c");

      expect(response.status).toBe(200);
    });

    it("não exige X-Forwarded-For de uma allowlist — não é o webhook", async () => {
      const app = createApp({
        logger: createLogger({}, { sink: () => undefined }),
        ipAllowlist: createIpAllowlistVerifier(),
        mlAccounts: {
          db: fakeMlAccountsDb(),
          oauth: OAUTH_CONFIG,
          encryptionKey: ENCRYPTION_KEY,
          logger: createLogger({}, { sink: () => undefined }),
          enqueuer: {
            enqueue: (request) =>
              Promise.resolve({
                taskName: "t",
                deduplicated: false,
                envelope: {
                  jobType: request.jobType,
                  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
                  organizationId: request.organizationId,
                  dedupeKey: request.dedupeKey,
                  attempt: 1,
                  enqueuedAt: "2026-08-21T15:00:00.000Z",
                },
              }),
          },
          requestOptions: {
            fetchImpl: () =>
              Promise.resolve(
                new Response(
                  JSON.stringify({
                    access_token: "APP_USR-token",
                    token_type: "bearer",
                    expires_in: 21_600,
                    scope: "offline_access read write",
                    user_id: 987654321,
                    refresh_token: "TG-refresh",
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
              ),
          },
        },
      });

      // Sem x-forwarded-for nenhum — a allowlist do webhook bloquearia isto.
      const response = await app.request("/oauth/mercado-livre/callback?state=s&code=c");

      expect(response.status).toBe(200);
    });
  });
});

describe("POST /v1/support/cases/:caseId/reply (D-096)", () => {
  const CASE_ID = "cccccccc-0000-4000-8000-000000000001";

  const CALLER: Caller = {
    userId: "aaaaaaaa-0000-4000-8000-000000000001",
    organizationId: "11111111-0000-4000-8000-000000000001",
    role: "OPERADOR",
  };

  /**
   * Fake de `authenticate` que respeita a lista de papéis permitidos — é o
   * que permite provar que ANALISTA é barrado nesta rota sem depender da
   * implementação real de `auth.ts`.
   */
  function authWithRole(role: Role) {
    return {
      authenticate: (_header: string | undefined, allowed: readonly Role[]): Promise<AuthResult> =>
        Promise.resolve(
          allowed.includes(role)
            ? { ok: true, caller: { ...CALLER, role } }
            : { ok: false, status: 403, reason: "papel sem permissão" },
        ),
    };
  }

  function supportReplyDeps(enqueued: EnqueueRequest[]) {
    const chain = <T,>(result: T) => {
      const self = { eq: () => self, maybeSingle: () => Promise.resolve(result) };
      return self;
    };

    return {
      logger: createLogger({}, { sink: () => undefined }),
      db: {
        from: (table: string) => ({
          select: () =>
            chain({
              data:
                table === "support_cases"
                  ? {
                      id: CASE_ID,
                      organization_id: CALLER.organizationId,
                      ml_account_id: "aaaaaaaa-0000-4000-8000-0000000000aa",
                      channel: "QUESTION",
                      external_case_id: "11436370259",
                      ml_accounts: { slug: "speedbikers-loja-1" },
                    }
                  : // O OPERADOR deste teste TEM permissão na conta — sem a
                    // linha, o envio agora para em `not_found` (D-117).
                    table === "user_account_permissions"
                    ? { user_id: CALLER.userId }
                    : null,
              error: null,
            }),
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: "eeeeeeee-0000-4000-8000-000000000001" }, error: null }),
            }),
          }),
        }),
      } as never,
      enqueuer: {
        enqueue: (request: EnqueueRequest) => {
          enqueued.push(request);

          return Promise.resolve({
            taskName: "t",
            deduplicated: false,
            envelope: {
              jobType: request.jobType,
              jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b43",
              organizationId: request.organizationId,
              dedupeKey: request.dedupeKey,
              attempt: 1,
              enqueuedAt: "2026-08-26T14:00:00.000Z",
            },
          });
        },
      },
    };
  }

  it("responde 503 sem as dependências de envio", async () => {
    const app = createApp({
      logger: createLogger({}, { sink: () => undefined }),
      auth: authWithRole("ADMIN"),
    });

    const response = await app.request(`/v1/support/cases/${CASE_ID}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientRequestId: "r1", text: "oi" }),
    });

    expect(response.status).toBe(503);
  });

  it("exige autenticação", async () => {
    const enqueued: EnqueueRequest[] = [];
    const app = createApp({
      logger: createLogger({}, { sink: () => undefined }),
      auth: { authenticate: () => Promise.resolve({ ok: false, status: 401, reason: "sem token" }) },
      supportReply: supportReplyDeps(enqueued),
    });

    const response = await app.request(`/v1/support/cases/${CASE_ID}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientRequestId: "r1", text: "oi" }),
    });

    expect(response.status).toBe(401);
    expect(enqueued).toHaveLength(0);
  });

  it("ANALISTA é barrado: lê o atendimento, não responde por ele (D-084)", async () => {
    const enqueued: EnqueueRequest[] = [];
    const app = createApp({
      logger: createLogger({}, { sink: () => undefined }),
      auth: authWithRole("ANALISTA"),
      supportReply: supportReplyDeps(enqueued),
    });

    const response = await app.request(`/v1/support/cases/${CASE_ID}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientRequestId: "r1", text: "oi" }),
    });

    expect(response.status).toBe(403);
    expect(enqueued).toHaveLength(0);
  });

  it("corpo sem clientRequestId responde 400 e não enfileira", async () => {
    const enqueued: EnqueueRequest[] = [];
    const app = createApp({
      logger: createLogger({}, { sink: () => undefined }),
      auth: authWithRole("OPERADOR"),
      supportReply: supportReplyDeps(enqueued),
    });

    const response = await app.request(`/v1/support/cases/${CASE_ID}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "oi" }),
    });

    expect(response.status).toBe(400);
    expect(enqueued).toHaveLength(0);
  });

  it("OPERADOR envia: enfileira o job na fila da conta", async () => {
    const enqueued: EnqueueRequest[] = [];
    const app = createApp({
      logger: createLogger({}, { sink: () => undefined }),
      auth: authWithRole("OPERADOR"),
      supportReply: supportReplyDeps(enqueued),
    });

    const response = await app.request(`/v1/support/cases/${CASE_ID}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientRequestId: "req-1", text: "Serve sim." }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "queued" });
    expect(enqueued[0]).toMatchObject({
      jobType: "support.reply.send",
      queue: "ml-sync-speedbikers-loja-1",
    });
  });
});
