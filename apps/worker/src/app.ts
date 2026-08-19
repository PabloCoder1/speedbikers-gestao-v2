import { jobEnvelopeSchema } from "@sb/contracts";
import type { Logger } from "@sb/observability";
import { measure } from "@sb/observability";
import { Hono } from "hono";

import { JOB_STATUS, toHttpStatus, toOutcome } from "./job-outcome.js";
import type { HandlerRegistry } from "./router.js";
import { handlers as defaultHandlers, resolveHandler } from "./router.js";

export interface WorkerDependencies {
  logger: Logger;
  registry?: HandlerRegistry;
  startedAt?: Date;
}

/**
 * O worker não tem rota pública.
 *
 * `/health` existe para o probe do Cloud Run; `/internal/jobs` recebe a
 * entrega do Cloud Tasks e é protegida por OIDC na plataforma (D-024), não
 * por segredo compartilhado.
 */
export function createWorkerApp(dependencies: WorkerDependencies): Hono {
  const app = new Hono();
  const registry = dependencies.registry ?? defaultHandlers;
  const startedAt = dependencies.startedAt ?? new Date();

  app.get("/health", (context) =>
    context.json({ status: "ok", service: "worker", startedAt: startedAt.toISOString() }),
  );

  app.post("/internal/jobs", async (context) => {
    const parsed = jobEnvelopeSchema.safeParse(await context.req.json().catch(() => null));

    if (!parsed.success) {
      // Envelope inválido nunca melhora com repetição.
      dependencies.logger.warn("invalid_job_envelope", {
        issues: parsed.error.issues.map((issue) => issue.message),
      });

      return context.json({ status: "rejected", reason: "envelope inválido" }, JOB_STATUS.badRequest);
    }

    const envelope = parsed.data;
    const handler = resolveHandler(envelope.jobType, registry);

    if (handler === undefined) {
      dependencies.logger.error("unknown_job_type", { job_type: envelope.jobType });

      return context.json(
        { status: "rejected", reason: "tipo de job desconhecido" },
        JOB_STATUS.badRequest,
      );
    }

    const logger = dependencies.logger.child({
      job_id: envelope.jobId,
      job_type: envelope.jobType,
      attempt: envelope.attempt,
    });

    const outcome = await measure(
      { operation: `job:${envelope.jobType}`, logger },
      async () => {
        try {
          return await handler(envelope, { logger });
        } catch (error) {
          // Diante da dúvida, repetir: descartar trabalho recuperável é pior.
          return toOutcome(error);
        }
      },
    );

    if (outcome.status === "failed") {
      logger.error("job_failed", { retryable: outcome.retryable, reason: outcome.reason });
    }

    return context.json(outcome, toHttpStatus(outcome));
  });

  return app;
}
