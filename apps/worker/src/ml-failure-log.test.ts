import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import { registrarFalhaDoMl } from "./ml-failure-log.js";

function logEmMemoria(): { logger: ReturnType<typeof createLogger>; linhas: string[] } {
  const linhas: string[] = [];

  return {
    logger: createLogger({ service: "test" }, { sink: (linha) => linhas.push(linha) }),
    linhas,
  };
}

describe("registrarFalhaDoMl", () => {
  it("registra o 403 com o corpo resumido -- o que o incidente de 25/09 precisava", () => {
    const { logger, linhas } = logEmMemoria();

    registrarFalhaDoMl(logger, {
      status: 403,
      method: "GET",
      path: "/orders/1",
      errorClass: "not_retryable",
      body: { message: "forbidden", status: 403 },
    });

    expect(linhas).toHaveLength(1);
    expect(JSON.parse(linhas[0] ?? "{}")).toMatchObject({
      message: "ml_http_failure",
      status: 403,
      path: "/orders/1",
      body: '{"message":"forbidden","status":403}',
    });
  });

  it("não registra o 404 -- a resposta normal de pedido sem desconto", () => {
    const { logger, linhas } = logEmMemoria();

    registrarFalhaDoMl(logger, {
      status: 404,
      method: "GET",
      path: "/orders/1/discounts",
      errorClass: "not_retryable",
      body: { error: "discount_not_found", status: 404 },
    });

    expect(linhas).toHaveLength(0);
  });
});
