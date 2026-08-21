import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import type { EnqueueRequest } from "./enqueue.js";
import { createIpAllowlistVerifier } from "./ip-allowlist.js";
import type { OidcVerifier } from "./oidc.js";
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
    });
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

describe("webhook do Mercado Livre", () => {
  const ALLOWED_IP = "54.88.218.97";
  const FORWARDED_ALLOWED = `${ALLOWED_IP},169.254.1.1`;
  const FORWARDED_DISALLOWED = "203.0.113.10,169.254.1.1";

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
