import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import type { OidcVerifier } from "./oidc.js";

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
