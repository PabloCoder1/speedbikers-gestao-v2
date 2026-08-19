import type { LogContext, Logger } from "./logger.js";

/**
 * Limite acima do qual uma leitura é considerada lenta.
 *
 * `docs/ARCHITECTURE.md` secao 20: logar quando um read model passa de 1.500 ms.
 * A V2 fazia isso e foi como os gargalos apareceram sem APM pago.
 */
export const SLOW_OPERATION_THRESHOLD_MS = 1_500;

export interface MeasureOptions {
  operation: string;
  logger: Logger;
  slowThresholdMs?: number;
  context?: LogContext;
}

/**
 * Executa uma operação medindo a duração.
 *
 * Só emite log quando passa do limite ou quando falha — instrumentação
 * silenciosa no caminho feliz mantém o volume de log utilizável.
 */
export async function measure<T>(
  options: MeasureOptions,
  run: () => Promise<T>,
): Promise<T> {
  const threshold = options.slowThresholdMs ?? SLOW_OPERATION_THRESHOLD_MS;
  const startedAt = performance.now();

  try {
    const result = await run();
    const elapsedMs = Math.round(performance.now() - startedAt);

    if (elapsedMs >= threshold) {
      options.logger.warn("slow_operation", {
        ...options.context,
        operation: options.operation,
        elapsedMs,
        thresholdMs: threshold,
      });
    }

    return result;
  } catch (error) {
    options.logger.error("operation_failed", {
      ...options.context,
      operation: options.operation,
      elapsedMs: Math.round(performance.now() - startedAt),
      error,
    });

    throw error;
  }
}
