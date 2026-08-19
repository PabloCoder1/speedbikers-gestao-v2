import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";

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
