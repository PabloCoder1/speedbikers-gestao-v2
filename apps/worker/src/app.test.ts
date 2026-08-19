import { createLogger } from "@sb/observability";
import { describe, expect, it, vi } from "vitest";

import { createWorkerApp } from "./app.js";
import type { HandlerRegistry } from "./router.js";

const validEnvelope = {
  jobType: "system.ping",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
  organizationId: "0b6d2f4a-1c3e-4a7b-8d5f-9e2c1a4b6d80",
  dedupeKey: "ping:1",
  attempt: 1,
  enqueuedAt: "2026-08-19T14:03:00.000Z",
};

function buildWorker(registry?: HandlerRegistry): {
  app: ReturnType<typeof createWorkerApp>;
  lines: string[];
} {
  const lines: string[] = [];
  const logger = createLogger({}, { sink: (line) => lines.push(line) });

  const dependencies = registry === undefined ? { logger } : { logger, registry };

  return { app: createWorkerApp(dependencies), lines };
}

async function post(app: ReturnType<typeof createWorkerApp>, body: unknown): Promise<Response> {
  return await app.request("/internal/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /health", () => {
  it("responde 200 para o probe do Cloud Run", async () => {
    const { app } = buildWorker();

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", service: "worker" });
  });
});

describe("POST /internal/jobs", () => {
  it("executa o handler registrado e responde 200", async () => {
    const { app } = buildWorker();

    const response = await post(app, validEnvelope);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "done", processed: 1 });
  });

  it("responde 400 para envelope inválido — repetir não resolveria", async () => {
    const { app } = buildWorker();

    expect((await post(app, { jobType: "system.ping" })).status).toBe(400);
  });

  it("responde 400 para corpo que não é JSON", async () => {
    const { app } = buildWorker();

    const response = await app.request("/internal/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "isto não é json",
    });

    expect(response.status).toBe(400);
  });

  it("responde 400 para tipo de job desconhecido", async () => {
    const { app } = buildWorker();

    const response = await post(app, { ...validEnvelope, jobType: "nao.existe" });

    expect(response.status).toBe(400);
  });

  it("não resolve handler por propriedade herdada de Object", async () => {
    const { app } = buildWorker();

    const response = await post(app, { ...validEnvelope, jobType: "constructor" });

    expect(response.status).toBe(400);
  });
});

describe("controle de retry do Cloud Tasks", () => {
  it("falha transitória responde 503, para a fila repetir", async () => {
    const { app } = buildWorker({
      "sync.orders.window": () =>
        Promise.resolve({ status: "failed", retryable: true, reason: "429 do Mercado Livre" }),
    });

    const response = await post(app, { ...validEnvelope, jobType: "sync.orders.window" });

    expect(response.status).toBe(503);
  });

  it("falha definitiva responde 422, para a fila descartar", async () => {
    const { app } = buildWorker({
      "sync.orders.window": () =>
        Promise.resolve({ status: "failed", retryable: false, reason: "conta desautorizada" }),
    });

    const response = await post(app, { ...validEnvelope, jobType: "sync.orders.window" });

    expect(response.status).toBe(422);
  });

  it("erro inesperado vira retryable: descartar trabalho recuperável é pior", async () => {
    const { app, lines } = buildWorker({
      "sync.orders.window": () => {
        throw new Error("socket hang up");
      },
    });

    const response = await post(app, { ...validEnvelope, jobType: "sync.orders.window" });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ retryable: true, reason: "socket hang up" });
    expect(lines.join()).toContain("job_failed");
  });

  it("executa o handler uma única vez por entrega", async () => {
    const handler = vi.fn(() => Promise.resolve({ status: "done" as const }));
    const { app } = buildWorker({ "sync.orders.window": handler });

    await post(app, { ...validEnvelope, jobType: "sync.orders.window" });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("registra o número da tentativa no log", async () => {
    const { app, lines } = buildWorker({
      "sync.orders.window": () =>
        Promise.resolve({ status: "failed", retryable: true, reason: "timeout" }),
    });

    await post(app, { ...validEnvelope, jobType: "sync.orders.window", attempt: 4 });

    expect(lines.join()).toContain('"attempt":4');
  });
});
