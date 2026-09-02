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

  // Estes quatro afirmavam 400, e o 400 era a crença de que "4xx a fila
  // descarta". D-201 mediu que não: o Cloud Tasks repete QUALQUER não-2xx, e
  // esses envelopes inválidos eram reentregues 8 vezes. Reescritos — e a
  // separação entre os dois primeiros e os dois últimos é o conteúdo novo.
  it("envelope inválido responde 2xx: repetir nunca o tornaria válido", async () => {
    const { app } = buildWorker();
    const response = await post(app, { jobType: "system.ping" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "rejected" });
  });

  it("corpo que não é JSON responde 2xx, pelo mesmo motivo", async () => {
    const { app } = buildWorker();

    const response = await app.request("/internal/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "isto não é json",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "rejected" });
  });

  // Tipo desconhecido é o caso OPOSTO, e por isso está separado: pode ser
  // permanente (tipo que não existe) ou temporário — a janela entre a `api`
  // passar a enfileirar um tipo novo e o worker novo subir. Descartar na
  // janela perderia trabalho real.
  it("tipo de job desconhecido responde 503: pode ser a janela de um deploy", async () => {
    const { app } = buildWorker();

    const response = await post(app, { ...validEnvelope, jobType: "nao.existe" });

    expect(response.status).toBe(503);
  });

  it("não resolve handler por propriedade herdada de Object", async () => {
    const { app } = buildWorker();

    const response = await post(app, { ...validEnvelope, jobType: "constructor" });

    expect(response.status).toBe(503);
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

  // O NOME deste teste era "falha definitiva responde 422, para a fila
  // descartar" — e a segunda metade da frase era falsa. O Cloud Tasks repete
  // qualquer não-2xx, então o 422 fazia a falha definitiva queimar as 8
  // tentativas da fila. Medido em D-201: 2.234 execuções extras em 7 dias.
  //
  // O 200 aqui não é fingir sucesso. É a única forma de dizer "não repita" —
  // e a verdade sobre o job continua no corpo e em `job_runs`, que é onde
  // alguém procura.
  it("falha definitiva responde 2xx, porque só 2xx faz a fila descartar", async () => {
    const { app } = buildWorker({
      "sync.orders.window": () =>
        Promise.resolve({ status: "failed", retryable: false, reason: "conta desautorizada" }),
    });

    const response = await post(app, { ...validEnvelope, jobType: "sync.orders.window" });

    expect(response.status).toBe(200);
    // O código diz à fila; o corpo diz a verdade.
    expect(await response.json()).toMatchObject({
      status: "failed",
      retryable: false,
      reason: "conta desautorizada",
    });
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

  // D-201 — o número da tentativa vem do CABEÇALHO, não do envelope.
  //
  // O corpo do job é o mesmo em toda reentrega do Cloud Tasks, então
  // `envelope.attempt` marcava 1 nas 2.234 execuções extras medidas. Quem
  // cresce é `X-CloudTasks-TaskRetryCount`, que a fila conta a partir de ZERO
  // — daí o `+ 1` para virar "tentativa número N".
  it("a tentativa vem do cabeçalho do Cloud Tasks, não do envelope", async () => {
    const { app, lines } = buildWorker({
      "sync.orders.window": () =>
        Promise.resolve({ status: "failed", retryable: true, reason: "timeout" }),
    });

    const response = await app.request("/internal/jobs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Terceira reentrega: a fila conta de zero.
        "x-cloudtasks-taskretrycount": "3",
      },
      body: JSON.stringify({ ...validEnvelope, jobType: "sync.orders.window", attempt: 1 }),
    });

    expect(response.status).toBe(503);
    // O envelope dizia 1. O cabeçalho manda.
    expect(lines.join()).toContain('"attempt":4');
    expect(lines.join()).not.toContain('"attempt":1');
  });

  it("sem o cabeçalho, cai no envelope — que é o melhor palpite, não zero", async () => {
    const { app, lines } = buildWorker({
      "sync.orders.window": () =>
        Promise.resolve({ status: "failed", retryable: true, reason: "timeout" }),
    });

    await post(app, { ...validEnvelope, jobType: "sync.orders.window", attempt: 7 });

    expect(lines.join()).toContain('"attempt":7');
  });

  it("cabeçalho ilegível não vira tentativa zero", async () => {
    const { app, lines } = buildWorker({
      "sync.orders.window": () =>
        Promise.resolve({ status: "failed", retryable: true, reason: "timeout" }),
    });

    const response = await app.request("/internal/jobs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cloudtasks-taskretrycount": "nao-e-numero",
      },
      body: JSON.stringify({ ...validEnvelope, jobType: "sync.orders.window", attempt: 2 }),
    });

    expect(response.status).toBe(503);
    expect(lines.join()).toContain('"attempt":2');
  });
});
