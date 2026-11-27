import type { Logger } from "@sb/observability";

import type { Caller } from "./auth.js";
import type { Enqueuer, EnqueueRequest } from "./enqueue.js";

export interface ConfirmApplyRejection {
  status: "rejected";
  reason: string;
}

/**
 * Executa a transição condicional `PARSED -> APPLYING`, exige linha afetada
 * para rejeitar corridas concorrentes antes de enfileirar e devolve para
 * `PARSED` se o enfileiramento falhar.
 */
export async function confirmAndEnqueueApply(options: {
  caller: Caller;
  logger: Logger;
  enqueuer: Enqueuer;
  job: EnqueueRequest;
  logPrefix: "erp_apply" | "nfe_apply";
  targetKey: "batch_id" | "document_id";
  targetId: string;
  markApplying: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
  rollbackApplying: () => Promise<{ error: { message: string } | null }>;
}): Promise<ConfirmApplyRejection | null> {
  const updated = await options.markApplying();

  if (updated.error !== null) {
    options.logger.error(`${options.logPrefix}_not_confirmed`, {
      [options.targetKey]: options.targetId,
      reason: updated.error.message,
    });

    return { status: "rejected", reason: "não foi possível confirmar a aplicação" };
  }

  if (updated.data === null) {
    options.logger.warn(`${options.logPrefix}_raced`, {
      [options.targetKey]: options.targetId,
    });

    return {
      status: "rejected",
      reason: "estado atual mudou antes da confirmação; atualize a página e tente de novo",
    };
  }

  try {
    await options.enqueuer.enqueue(options.job);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    options.logger.error(`${options.logPrefix}_enqueue_failed`, {
      [options.targetKey]: options.targetId,
      reason,
    });

    try {
      const reverted = await options.rollbackApplying();

      if (reverted.error !== null) {
        options.logger.error(`${options.logPrefix}_rollback_failed`, {
          [options.targetKey]: options.targetId,
          reason: reverted.error.message,
        });
      }
    } catch (rollbackError) {
      options.logger.error(`${options.logPrefix}_rollback_failed`, {
        [options.targetKey]: options.targetId,
        reason: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }

    throw error;
  }

  options.logger.info(`${options.logPrefix}_confirmed`, {
    [options.targetKey]: options.targetId,
    confirmed_by: options.caller.userId,
  });

  return null;
}
