/**
 * Resultado de um job e sua tradução para status HTTP.
 *
 * O status HTTP **é** o mecanismo de controle de retry do Cloud Tasks: 2xx
 * encerra a task, 4xx a descarta sem repetir, 5xx agenda nova tentativa com
 * backoff. Devolver a classe errada significa reprocessar para sempre um job
 * envenenado, ou perder trabalho recuperável em silêncio.
 *
 * A classificação segue docs/API.md secao 6.
 */

export type JobOutcome =
  | { status: "done"; processed?: number }
  | { status: "failed"; retryable: boolean; reason: string };

export const JOB_STATUS = {
  /** Concluído. A task sai da fila. */
  done: 200,
  /** Falha definitiva: repetir não muda o resultado. A task é descartada. */
  permanentFailure: 422,
  /** Falha transitória: rate limit, indisponibilidade, timeout. Repetir. */
  transientFailure: 503,
  /** Envelope inválido ou tipo desconhecido: repetir nunca vai resolver. */
  badRequest: 400,
} as const;

export type JobHttpStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export function toHttpStatus(outcome: JobOutcome): JobHttpStatus {
  if (outcome.status === "done") {
    return JOB_STATUS.done;
  }

  return outcome.retryable ? JOB_STATUS.transientFailure : JOB_STATUS.permanentFailure;
}

/**
 * Classifica um erro inesperado de handler.
 *
 * O padrão é **retryable**: diante da dúvida, é melhor tentar de novo do que
 * descartar trabalho. Falha definitiva precisa ser declarada explicitamente
 * pelo handler.
 */
export function toOutcome(error: unknown): JobOutcome {
  return {
    status: "failed",
    retryable: true,
    reason: error instanceof Error ? error.message : "erro desconhecido",
  };
}
