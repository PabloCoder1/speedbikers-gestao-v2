import { describe, expect, it } from "vitest";

import { createLogger, redact } from "./logger.js";
import type { LogContext } from "./logger.js";

function captureLogger(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];

  const logger = createLogger(
    {},
    {
      sink: (line) => lines.push(line),
      now: () => new Date("2026-08-19T14:03:00.000Z"),
    },
  );

  return { lines, logger };
}

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe("createLogger", () => {
  it("emite JSON de uma linha com severity, message e timestamp", () => {
    const { lines, logger } = captureLogger();

    logger.info("sync_started", { account: "offracer" });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(parse(lines[0] ?? "")).toEqual({
      severity: "INFO",
      message: "sync_started",
      timestamp: "2026-08-19T14:03:00.000Z",
      account: "offracer",
    });
  });

  it("mapeia warn para WARNING, que é o nível do Cloud Logging", () => {
    const { lines, logger } = captureLogger();

    logger.warn("slow_operation");

    expect(parse(lines[0] ?? "").severity).toBe("WARNING");
  });

  it("child carrega o contexto fixo em toda linha", () => {
    const { lines, logger } = captureLogger();

    logger.child({ request_id: "abc" }).error("failed", { step: 2 });

    expect(parse(lines[0] ?? "")).toMatchObject({
      severity: "ERROR",
      request_id: "abc",
      step: 2,
    });
  });

  it("child não vaza contexto para o logger de origem", () => {
    const { lines, logger } = captureLogger();

    logger.child({ job_id: "j1" });
    logger.info("sem contexto");

    expect(parse(lines[0] ?? "")).not.toHaveProperty("job_id");
  });

  it("serializa Error com nome, mensagem e stack", () => {
    const { lines, logger } = captureLogger();

    logger.error("boom", { error: new TypeError("preço inválido") });

    const error = parse(lines[0] ?? "").error as Record<string, unknown>;

    expect(error.name).toBe("TypeError");
    expect(error.message).toBe("preço inválido");
    expect(error.stack).toContain("TypeError");
  });
});

describe("redact", () => {
  it.each([
    "access_token",
    "refresh_token",
    "clientSecret",
    "password",
    "authorization",
    "apiKey",
    "api_key",
    "credential",
    "cookie",
  ])("redige a chave %s", (key) => {
    expect(redact({ [key]: "valor-real" })[key]).toBe("[REDACTED]");
  });

  it("redige em profundidade", () => {
    const input: LogContext = { conta: { nome: "offracer", access_token: "segredo" } };

    const output = redact(input) as { conta: Record<string, unknown> };

    expect(output.conta.nome).toBe("offracer");
    expect(output.conta.access_token).toBe("[REDACTED]");
  });

  it("preserva valores que não são sensíveis", () => {
    expect(redact({ sku: "TC453", unidades: 12 })).toEqual({ sku: "TC453", unidades: 12 });
  });

  it("nunca deixa passar o segredo nem parcialmente", () => {
    const line = JSON.stringify(redact({ ml_access_token: "APP_USR-123456" }));

    expect(line).not.toContain("APP_USR");
    expect(line).not.toContain("123456");
  });
});

/**
 * A SEGUNDA CAMADA (D-330): o valor, e não só o nome da chave.
 *
 * O caso que motivou: `{ reason: error.message }` — a chave é inocente, e a
 * mensagem de um cliente de terceiro pode carregar o token. Todos os valores
 * abaixo são FIXTURE.
 */
describe("redact por valor", () => {
  it("troca o token que chega dentro de uma chave inocente", () => {
    const line = JSON.stringify(redact({ reason: "troca falhou: APP_USR-1234567890-fixture" }));

    expect(line).not.toContain("APP_USR-1234567890");
    expect(line).toContain("troca falhou");
  });

  it("troca o JWT depois de Bearer na mensagem E na stack de um Error", () => {
    const { lines, logger } = captureLogger();
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.assinaturafixture123";

    logger.error("chamada_falhou", { error: new Error(`401 com Authorization: Bearer ${jwt}`) });

    const linha = lines[0] ?? "";
    const error = parse(linha).error as Record<string, unknown>;

    expect(linha).not.toContain(jwt);
    expect(error.message).toContain("401");
    expect(String(error.stack)).not.toContain("eyJhbGciOi");
  });

  it("desce em array de strings, que antes passava intacto", () => {
    const output = redact({ tentativas: ["ok", "sk-ant-fixture-1234567"] }) as { tentativas: string[] };

    expect(output.tentativas[0]).toBe("ok");
    expect(output.tentativas[1]).not.toContain("sk-ant-fixture");
  });

  it("não mexe em número, booleano e nulo", () => {
    expect(redact({ unidades: 12, retry: true, conta: null })).toEqual({ unidades: 12, retry: true, conta: null });
  });

  it("não come a mensagem benigna — ela precisa continuar dizendo o que aconteceu", () => {
    expect(redact({ reason: "troca de token: invalid_client" })).toEqual({ reason: "troca de token: invalid_client" });
  });
});
