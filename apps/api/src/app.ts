import { randomUUID } from "node:crypto";

import type { Logger } from "@sb/observability";
import { Hono } from "hono";

/**
 * Variáveis carregadas no contexto do request.
 *
 * Declarar o tipo é o que permite usar `context.get("requestId")` sem cast — e
 * o que faz o compilador reclamar se alguém ler uma variável que nunca foi
 * escrita.
 */
export interface AppVariables {
  requestId: string;
}

export interface AppEnv { Variables: AppVariables }

export interface AppDependencies {
  logger: Logger;
  startedAt?: Date;
}

/**
 * Monta a aplicação HTTP.
 *
 * Recebe as dependências em vez de criá-las para que o teste possa observar o
 * log sem tocar em stdout.
 */
export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const startedAt = dependencies.startedAt ?? new Date();

  // Todo request carrega um id, propagado no log e devolvido no header. É o que
  // permite correlacionar uma linha de log com uma requisição concreta.
  app.use("*", async (context, next) => {
    const requestId = context.req.header("x-request-id") ?? randomUUID();

    context.set("requestId", requestId);
    context.header("x-request-id", requestId);

    await next();
  });

  app.get("/health", (context) => {
    return context.json({
      status: "ok",
      service: "api",
      startedAt: startedAt.toISOString(),
    });
  });

  app.notFound((context) => {
    return context.json(
      {
        error: {
          code: "not_found",
          message: "Recurso não encontrado.",
          request_id: context.get("requestId"),
        },
      },
      404,
    );
  });

  app.onError((error, context) => {
    const requestId = context.get("requestId");

    dependencies.logger.error("unhandled_request_error", {
      request_id: requestId,
      path: context.req.path,
      error,
    });

    // Nunca vazar detalhe interno na resposta. Ver docs/API.md secao 6.
    return context.json(
      {
        error: {
          code: "internal_error",
          message: "Erro interno.",
          request_id: requestId,
        },
      },
      500,
    );
  });

  return app;
}
