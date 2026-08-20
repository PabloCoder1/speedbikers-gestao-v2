import { randomUUID } from "node:crypto";

import { CloudTasksClient } from "@google-cloud/tasks";
import type { JobEnvelope } from "@sb/contracts";
import { jobEnvelopeSchema, toTaskName } from "@sb/contracts";

import type { Env } from "./env.js";

/**
 * Enfileiramento no Cloud Tasks.
 *
 * A `api` nunca executa trabalho longo: ela enfileira e responde
 * (docs/ARCHITECTURE.md secao 5).
 */

export interface EnqueueRequest {
  jobType: string;
  organizationId: string;
  /** Chave lógica do trabalho. Duas chamadas com a mesma chave = um job. */
  dedupeKey: string;
  queue: string;
  payload?: Record<string, unknown>;
  /** Atraso antes da entrega. É o que dá a janela de deduplicação. */
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
  // Anotação explícita: sem ela o tipo inferido referencia um caminho interno
  // do pacote e a declaração gerada deixa de ser portátil.
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

      // O NOME da task é o mecanismo de deduplicação: o Cloud Tasks recusa um
      // nome que já existe. É isso que faz cem vendas do mesmo SKU no mesmo dia
      // virarem um recálculo (docs/ARCHITECTURE.md secao 10).
      const taskName = `${parent}/tasks/${toTaskName(request.dedupeKey)}`;

      const body = Buffer.from(
        JSON.stringify({ ...envelope, payload: request.payload ?? {} }),
      ).toString("base64");

      // Com `exactOptionalPropertyTypes`, passar `scheduleTime: undefined` não
      // é o mesmo que omitir. Montar condicionalmente.
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
              // OIDC, não segredo compartilhado (D-024). O worker é privado e
              // só aceita esta identidade.
              oidcToken: {
                serviceAccountEmail: env.TASKS_INVOKER_SERVICE_ACCOUNT,
                audience: env.WORKER_URL,
              },
            },
          },
        });

        return { taskName, envelope, deduplicated: false };
      } catch (error) {
        // ALREADY_EXISTS não é falha: é a deduplicação funcionando. Tratar como
        // erro faria o chamador repetir um trabalho que já está agendado.
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
