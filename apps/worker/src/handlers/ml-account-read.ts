import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext } from "../router.js";

/**
 * Resolve a leitura de uma linha de `ml_accounts` para os handlers do worker:
 * erro de Postgres/PostgREST é transitório (`retryable: true`) e não pode ser
 * confundido com conta removida (`data === null`), que encerra o job sem retry.
 */
export function resolveMlAccountRead<T>(
  accountRead: { data: T | null; error: { message: string } | null },
  options: {
    logger: HandlerContext["logger"];
    missingEvent: string;
    mlAccountId: string;
  },
): { account: T } | { outcome: JobOutcome } {
  if (accountRead.error !== null) {
    return {
      outcome: {
        status: "failed",
        retryable: true,
        reason: `falha ao ler conta Mercado Livre: ${accountRead.error.message}`,
      },
    };
  }

  if (accountRead.data === null) {
    options.logger.warn(options.missingEvent, { ml_account_id: options.mlAccountId });

    return { outcome: { status: "done", processed: 0 } };
  }

  return { account: accountRead.data };
}
