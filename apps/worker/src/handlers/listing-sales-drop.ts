import type { AdminClient } from "@sb/db";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";

/**
 * `diagnostics.listing-sales-drop` (D-629, C-79) — a queda nas vendas por
 * anúncio, recalculada uma vez por dia e por organização, para a lista de
 * `/anuncios` ler por junção (o atalho "Queda nas vendas" e a contagem).
 *
 * **Toda a regra mora no banco.** `recalcular_queda_anuncios` compara as
 * unidades de cada período da tela (7, 15, 30, 60 e 90 dias fechados até
 * ontem) com as 8 janelas anteriores de mesmo tamanho e regrava a organização
 * numa transação: repetir é idempotente. Este handler só chama e registra.
 *
 * Mesmo gatilho diário dos diagnósticos (D-116): o Cloud Scheduler das 8h
 * enfileira os quatro por organização.
 */

const payloadSchema = z.object({ organizationId: z.uuid() });

const resultadoSchema = z.object({
  linhas: z.number(),
  em_queda: z.number(),
  periodo_ate: z.string(),
});

export interface ListingSalesDropDeps {
  db: AdminClient;
}

export function createListingSalesDropHandler(deps: ListingSalesDropDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem organizationId" };
    }

    const { organizationId } = parsed.data;
    const result = await deps.db.rpc("recalcular_queda_anuncios", { p_organization_id: organizationId });

    if (result.error !== null) {
      return { status: "failed", retryable: true, reason: `recalcular_queda_anuncios: ${result.error.message}` };
    }

    const resumo = resultadoSchema.safeParse(result.data);

    // A transação já gravou; resposta fora do formato é defeito de contrato,
    // e repetir não conserta.
    if (!resumo.success) {
      return { status: "failed", retryable: false, reason: "recalcular_queda_anuncios fora do contrato" };
    }

    context.logger.info("listing_sales_drop_done", {
      organization_id: organizationId,
      linhas: resumo.data.linhas,
      em_queda: resumo.data.em_queda,
      periodo_ate: resumo.data.periodo_ate,
    });

    return { status: "done", processed: resumo.data.linhas };
  };
}
