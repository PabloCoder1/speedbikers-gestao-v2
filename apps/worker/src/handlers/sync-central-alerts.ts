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
 * **Uma fonte por chamada (D-404).** As três numa chamada só estouraram o
 * `statement_timeout` de 8 s com o banco frio, no primeiro disparo em
 * produção (8.066 ms). Cada fonte tem agora a sua transação e o seu teto; a
 * que falhar não impede as outras, e o job volta para a fila (o banco é
 * idempotente por dia: repetir a que passou só atualiza o que já gravou).
 *
 * Mesmo gatilho diário de `detect-sales-anomalies` (D-116): o Cloud Scheduler
 * das 8h enfileira os três diagnósticos por organização.
 */

const payloadSchema = z.object({ organizationId: z.uuid() });

/** Na ordem das chamadas: a mais pesada (o detector de frete, 4,4 s frio) primeiro. */
export const FONTES_ALERTAS = ["frete_anomalo", "ads_campanha", "produto_prejuizo"] as const;

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
    const falhas: string[] = [];
    let processadas = 0;
    let foraDoContrato = false;

    for (const fonte of FONTES_ALERTAS) {
      const result = await deps.db.rpc("sincronizar_alertas_central", {
        p_organization_id: organizationId,
        p_fontes: [fonte],
      });

      if (result.error !== null) {
        falhas.push(`${fonte}: ${result.error.message}`);

        continue;
      }

      const resumo = resultadoSchema.safeParse(result.data);

      // A transação já gravou; resposta fora do formato é defeito de contrato,
      // e repetir não conserta.
      if (!resumo.success) {
        foraDoContrato = true;
        falhas.push(`${fonte}: sincronizar_alertas_central fora do contrato`);

        continue;
      }

      const r = resumo.data;

      processadas += r.criadas + r.atualizadas + r.encerradas;
      context.logger.info("sync_central_alerts_done", {
        organization_id: organizationId,
        fonte,
        hoje: r.hoje,
        rodou: r.fontes.includes(fonte),
        detectados: r.detectados,
        criadas: r.criadas,
        atualizadas: r.atualizadas,
        continuas: r.continuas,
        encerradas: r.encerradas,
      });
    }

    if (falhas.length > 0) {
      return { status: "failed", retryable: !foraDoContrato, reason: falhas.join("; ") };
    }

    return { status: "done", processed: processadas };
  };
}
