import type { JobEnvelope } from "@sb/contracts";
import type { Logger } from "@sb/observability";

import type { JobOutcome } from "./job-outcome.js";

export interface HandlerContext {
  logger: Logger;

  /**
   * Payload específico do job, fora do envelope.
   *
   * O `jobEnvelopeSchema` remove chaves desconhecidas — comportamento padrão do
   * Zod e desejável, porque impede um campo inesperado virar contrato por
   * acidente. Por isso o payload trafega separado e cada handler valida o seu.
   */
  payload: unknown;
}

export type JobHandler = (envelope: JobEnvelope, context: HandlerContext) => Promise<JobOutcome>;

export type HandlerRegistry = Readonly<Record<string, JobHandler>>;

/**
 * Registro de handlers por tipo de job.
 *
 * Um worker só, com roteamento por tipo — não um serviço por domínio. Ver
 * docs/ARCHITECTURE.md secao 6.
 */
export const handlers: HandlerRegistry = {
  /**
   * Job de verificação da malha. Não toca em domínio nenhum; existe para
   * provar que `api -> Cloud Tasks -> worker` está inteiro.
   */
  "system.ping": (envelope, context) => {
    context.logger.info("ping_received", {
      job_id: envelope.jobId,
      dedupe_key: envelope.dedupeKey,
    });

    return Promise.resolve({ status: "done", processed: 1 });
  },
};

/**
 * Handlers que precisam de dependência externa não podem viver na constante
 * acima — eles são montados no boot, com banco e bucket já configurados.
 */
export function withHandlers(extra: HandlerRegistry): HandlerRegistry {
  return { ...handlers, ...extra };
}

export function resolveHandler(
  jobType: string,
  registry: HandlerRegistry = handlers,
): JobHandler | undefined {
  return Object.hasOwn(registry, jobType) ? registry[jobType] : undefined;
}
