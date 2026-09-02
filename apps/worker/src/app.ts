import { jobEnvelopeSchema } from "@sb/contracts";
import type { AdminClient } from "@sb/db";
import { recordJobRun } from "@sb/db";
import type { Logger } from "@sb/observability";
import { measure } from "@sb/observability";
import { Hono } from "hono";

import { JOB_STATUS, resolveAttempt, toHttpStatus, toOutcome } from "./job-outcome.js";
import type { HandlerRegistry } from "./router.js";
import { handlers as defaultHandlers, resolveHandler } from "./router.js";

export interface WorkerDependencies {
  logger: Logger;
  registry?: HandlerRegistry;
  startedAt?: Date;
  /** Ausente nos testes de rota: gravar o histórico não é o que eles medem. */
  db?: AdminClient;
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
    const body: unknown = await context.req.json().catch(() => null);
    const parsed = jobEnvelopeSchema.safeParse(body);

    if (!parsed.success) {
      // Envelope inválido nunca melhora com repetição.
      dependencies.logger.warn("invalid_job_envelope", {
        issues: parsed.error.issues.map((issue) => issue.message),
      });

      return context.json({ status: "rejected", reason: "envelope inválido" }, JOB_STATUS.invalidEnvelope);
    }

    const envelope = parsed.data;
    const handler = resolveHandler(envelope.jobType, registry);

    if (handler === undefined) {
      dependencies.logger.error("unknown_job_type", { job_type: envelope.jobType });

      return context.json(
        { status: "rejected", reason: "tipo de job desconhecido" },
        JOB_STATUS.unknownJobType,
      );
    }

    // Quantas entregas o Cloud Tasks ja fez, e nao o que o envelope diz: o
    // corpo do job e o MESMO em toda reentrega, entao `envelope.attempt`
    // marcava 1 nas 2.234 execucoes extras que D-201 mediu. O cabecalho e a
    // unica fonte que cresce.
    const attempt = resolveAttempt(
      context.req.header("x-cloudtasks-taskretrycount"),
      envelope.attempt,
    );

    const logger = dependencies.logger.child({
      job_id: envelope.jobId,
      job_type: envelope.jobType,
      attempt,
    });

    const startedProcessingAt = new Date();

    const outcome = await measure(
      { operation: `job:${envelope.jobType}`, logger },
      async () => {
        try {
          // O `in` já estreita o tipo; a asserção seria redundante.
          const payload =
            typeof body === "object" && body !== null && "payload" in body
              ? body.payload
              : undefined;

          return await handler(envelope, { logger, payload });
        } catch (error) {
          // Diante da dúvida, repetir: descartar trabalho recuperável é pior.
          return toOutcome(error);
        }
      },
    );

    if (outcome.status === "failed") {
      logger.error("job_failed", { retryable: outcome.retryable, reason: outcome.reason });
    }

    // Histórico em L2. Best-effort DE PROPÓSITO: se a gravação falhar, o job
    // continua com o resultado que teve. Deixar a observabilidade derrubar a
    // operação faria o Cloud Tasks repetir um trabalho que já deu certo.
    if (dependencies.db !== undefined) {
      const finishedAt = new Date();

      const recorded = await recordJobRun(dependencies.db, {
        organization_id: envelope.organizationId,
        job_id: envelope.jobId,
        job_type: envelope.jobType,
        dedupe_key: envelope.dedupeKey,
        attempt,
        status: outcome.status,
        retryable: outcome.status === "failed" ? outcome.retryable : null,
        reason: outcome.status === "failed" ? outcome.reason : null,
        processed: outcome.status === "done" ? (outcome.processed ?? null) : null,
        started_at: startedProcessingAt.toISOString(),
        finished_at: finishedAt.toISOString(),
      });

      if (!recorded.ok) {
        logger.error("job_run_not_recorded", { reason: recorded.reason });
      }
    }

    return context.json(outcome, toHttpStatus(outcome));
  });

  return app;
}
