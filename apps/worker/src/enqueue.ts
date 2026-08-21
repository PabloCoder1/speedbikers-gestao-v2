import { randomUUID } from "node:crypto";

import { CloudTasksClient } from "@google-cloud/tasks";
import type { JobEnvelope } from "@sb/contracts";
import { jobEnvelopeSchema, toTaskName } from "@sb/contracts";

import type { Env } from "./env.js";

/**
 * Enfileiramento no Cloud Tasks, de dentro do próprio `worker`.
 *
 * Duplicado de `apps/api/src/enqueue.ts` em vez de extraído para um pacote
 * compartilhado: os dois apps ficam livres para evoluir o formato de deploy
 * (env vars, service account) sem um acoplar o outro, e o arquivo é pequeno
 * o bastante para a duplicação não doer.
 *
 * Único consumidor hoje: `backfill.orders` se reenfileirando (fila
 * `backfill`) até cobrir os 12 meses de histórico — `docs/HANDOFF.md`.
 * `reconciliação`/`webhook` continuam só a `api` enfileirando.
 */

export interface EnqueueRequest {
  jobType: string;
  organizationId: string;
  dedupeKey: string;
  queue: string;
  payload?: Record<string, unknown>;
  delaySeconds?: number;
}

export interface EnqueueResult {
  taskName: string;
  envelope: JobEnvelope;
  deduplicated: boolean;
}

export interface Enqueuer {
  enqueue: (request: EnqueueRequest) => Promise<EnqueueResult>;
}

export function createEnqueuer(
  env: Env,
  client: CloudTasksClient = new CloudTasksClient(),
): Enqueuer {
  return {
    enqueue: async (request) => {
      const envelope: JobEnvelope = jobEnvelopeSchema.parse({
        jobType: request.jobType,
        jobId: randomUUID(),
        organizationId: request.organizationId,
        dedupeKey: request.dedupeKey,
        attempt: 1,
        enqueuedAt: new Date().toISOString(),
      });

      const parent = client.queuePath(env.GCP_PROJECT_ID, env.GCP_REGION, request.queue);
      const taskName = `${parent}/tasks/${toTaskName(request.dedupeKey)}`;

      const body = Buffer.from(
        JSON.stringify({ ...envelope, payload: request.payload ?? {} }),
      ).toString("base64");

      const scheduleTime =
        request.delaySeconds === undefined
          ? {}
          : {
              scheduleTime: {
                seconds: Math.floor(Date.now() / 1000) + request.delaySeconds,
              },
            };

      try {
        await client.createTask({
          parent,
          task: {
            name: taskName,
            ...scheduleTime,
            httpRequest: {
              httpMethod: "POST",
              url: `${env.WORKER_URL}/internal/jobs`,
              headers: { "Content-Type": "application/json" },
              body,
              // O worker se reenfileira PARA SI MESMO — mesma identidade OIDC
              // que o Cloud Tasks já usa para entregar qualquer job (D-024).
              oidcToken: {
                serviceAccountEmail: env.TASKS_INVOKER_SERVICE_ACCOUNT,
                audience: env.WORKER_URL,
              },
            },
          },
        });

        return { taskName, envelope, deduplicated: false };
      } catch (error) {
        // ALREADY_EXISTS não é falha: é a deduplicação funcionando.
        if (isAlreadyExists(error)) {
          return { taskName, envelope, deduplicated: true };
        }

        throw error;
      }
    },
  };
}

/** Código 6 do gRPC é ALREADY_EXISTS. */
function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 6;
}
