import type { AdminClient } from "@sb/db";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";

/**
 * Um único tipo de job cobre o caminho quente e o rebuild administrativo.
 * Ambos terminam nas RPCs transacionais da migration
 * `20260821184047_create_sales_metrics_recompute.sql` e, portanto, reutilizam
 * exatamente o mesmo cálculo SQL dos três grãos.
 */
const payloadSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("incremental"),
    mlAccountId: z.uuid(),
    metricDate: z.iso.date(),
  }),
  z
    .object({
      mode: z.literal("rebuild"),
      mlAccountId: z.uuid(),
      dateFrom: z.iso.date(),
      dateTo: z.iso.date(),
    })
    .refine((payload) => payload.dateFrom <= payload.dateTo, {
      message: "dateFrom posterior a dateTo",
    }),
]);

export interface AnalyticsRecomputeDeps {
  db: AdminClient;
}

export function createAnalyticsRecomputeHandler(deps: AnalyticsRecomputeDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload de recálculo inválido" };
    }

    const payload = parsed.data;
    const account = await deps.db
      .from("ml_accounts")
      .select("id, organization_id")
      .eq("id", payload.mlAccountId)
      .maybeSingle();

    if (account.error !== null) {
      return { status: "failed", retryable: true, reason: account.error.message };
    }

    if (account.data === null) {
      context.logger.info("analytics_recompute_account_missing", {
        ml_account_id: payload.mlAccountId,
      });

      return { status: "done", processed: 0 };
    }

    if (account.data.organization_id !== envelope.organizationId) {
      return {
        status: "failed",
        retryable: false,
        reason: "conta não pertence à organização do job",
      };
    }

    const result =
      payload.mode === "incremental"
        ? await deps.db.rpc("recompute_daily_sales_metrics", {
            p_organization_id: envelope.organizationId,
            p_ml_account_id: payload.mlAccountId,
            p_metric_date: payload.metricDate,
          })
        : await deps.db.rpc("rebuild_daily_sales_metrics", {
            p_organization_id: envelope.organizationId,
            p_ml_account_id: payload.mlAccountId,
            p_date_from: payload.dateFrom,
            p_date_to: payload.dateTo,
          });

    if (result.error !== null) {
      context.logger.error("analytics_recompute_rpc_failed", {
        ml_account_id: payload.mlAccountId,
        mode: payload.mode,
        reason: result.error.message,
      });

      // A RPC valida payload/ownership antes de chegar aqui. Falhas restantes
      // sao operacionais (conexao, lock, indisponibilidade) e podem melhorar.
      return { status: "failed", retryable: true, reason: result.error.message };
    }

    const processed = result.data;

    context.logger.info("analytics_recompute_done", {
      ml_account_id: payload.mlAccountId,
      mode: payload.mode,
      rows_materialized: processed,
    });

    return { status: "done", processed };
  };
}
