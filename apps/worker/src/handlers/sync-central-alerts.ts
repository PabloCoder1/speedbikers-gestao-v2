import type { AdminClient } from "@sb/db";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";

/**
 * `diagnostics.sync-central-alerts` (D-403) — os alertas da central viram
 * itens da Central de Ações, uma vez por dia e por organização.
 *
 * **Toda a regra mora no banco.** `sincronizar_alertas_central` lê os três
 * detectores que a central já mostra (frete, Ads, produto no prejuízo), e faz
 * numa transação o ciclo de vida de cada episódio: atualiza o aberto, respeita
 * o que uma pessoa fechou, abre o novo e encerra o que sumiu. Este handler só
 * chama e registra o que aconteceu: agregação em SQL, nunca em JavaScript.
 *
 * Mesmo gatilho diário de `detect-sales-anomalies` (D-116): o Cloud Scheduler
 * das 8h enfileira os três diagnósticos por organização.
 */

const payloadSchema = z.object({ organizationId: z.uuid() });

const resultadoSchema = z.object({
  hoje: z.string(),
  fontes: z.array(z.string()),
  detectados: z.record(z.string(), z.number()),
  atualizadas: z.number(),
  continuas: z.number(),
  criadas: z.number(),
  encerradas: z.number(),
});

export interface SyncCentralAlertsDeps {
  db: AdminClient;
}

export function createSyncCentralAlertsHandler(deps: SyncCentralAlertsDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem organizationId" };
    }

    const { organizationId } = parsed.data;
    const result = await deps.db.rpc("sincronizar_alertas_central", { p_organization_id: organizationId });

    if (result.error !== null) {
      return { status: "failed", retryable: true, reason: result.error.message };
    }

    const resumo = resultadoSchema.safeParse(result.data);

    // A transação já gravou; resposta fora do formato é defeito de contrato,
    // e repetir não conserta.
    if (!resumo.success) {
      return { status: "failed", retryable: false, reason: "sincronizar_alertas_central fora do contrato" };
    }

    const r = resumo.data;

    context.logger.info("sync_central_alerts_done", {
      organization_id: organizationId,
      hoje: r.hoje,
      fontes: r.fontes,
      detectados: r.detectados,
      criadas: r.criadas,
      atualizadas: r.atualizadas,
      continuas: r.continuas,
      encerradas: r.encerradas,
    });

    return { status: "done", processed: r.criadas + r.atualizadas + r.encerradas };
  };
}
