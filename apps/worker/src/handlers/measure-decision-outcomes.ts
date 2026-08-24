import type { AdminClient, Json } from "@sb/db";
import { computePendingOutcomeWindows, shiftBusinessDate, toSalesMetricDate } from "@sb/domain";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";

/**
 * `diagnostics.measure-decision-outcomes` — Memória de decisões
 * operacionais, terceira e última peça da Fase 6 (`docs/PROMPT_MASTER.md`
 * secao 29).
 *
 * `create_action_decision` (RPC) já capturou o `baseline_snapshot` no
 * momento da decisão. Este job só decide QUANDO cada janela (7/15/30 dias)
 * amadureceu (`computePendingOutcomeWindows`, pura) e grava o
 * `outcome_snapshot` correspondente — mesma função SQL do baseline
 * (`get_sku_decision_snapshot`), só muda o `as_of`.
 *
 * **Por organização**, não por conta ML — SKU é organizacional (D-006),
 * mesmo raciocínio de `verify-ledger-integrity`/`detect-sales-anomalies`.
 *
 * Medição histórica FIXA: uma janela já medida nunca é recalculada
 * (`unique (action_decision_id, window_days)` + `ignoreDuplicates`), mesmo
 * que o job rode mais de uma vez no mesmo dia.
 */

const payloadSchema = z.object({ organizationId: z.uuid() });

export interface MeasureDecisionOutcomesDeps {
  db: AdminClient;
  now?: () => Date;
}

interface DecisionRow {
  id: string;
  action_id: string;
  created_at: string;
}

interface OutcomeRow {
  action_decision_id: string;
  window_days: number;
}

interface ActionRow {
  id: string;
  sku_id: string | null;
}

export function createMeasureDecisionOutcomesHandler(deps: MeasureDecisionOutcomesDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem organizationId" };
    }

    const { organizationId } = parsed.data;
    const now = deps.now?.() ?? new Date();
    const asOf = shiftBusinessDate(toSalesMetricDate(now), -1);

    const decisionsResult = await deps.db
      .from("action_decisions")
      .select("id, action_id, created_at")
      .eq("organization_id", organizationId);

    if (decisionsResult.error !== null) {
      return { status: "failed", retryable: true, reason: decisionsResult.error.message };
    }

    const decisions = decisionsResult.data as DecisionRow[];

    if (decisions.length === 0) {
      context.logger.info("measure_decision_outcomes_done", { organization_id: organizationId, measured: 0 });

      return { status: "done", processed: 0 };
    }

    const decisionIds = decisions.map((d) => d.id);
    const actionIds = [...new Set(decisions.map((d) => d.action_id))];

    const outcomesResult = await deps.db
      .from("action_outcomes")
      .select("action_decision_id, window_days")
      .in("action_decision_id", decisionIds);

    if (outcomesResult.error !== null) {
      return { status: "failed", retryable: true, reason: outcomesResult.error.message };
    }

    const measuredByDecision = new Map<string, number[]>();

    for (const row of outcomesResult.data as OutcomeRow[]) {
      const list = measuredByDecision.get(row.action_decision_id) ?? [];
      list.push(row.window_days);
      measuredByDecision.set(row.action_decision_id, list);
    }

    const actionsResult = await deps.db.from("actions").select("id, sku_id").in("id", actionIds);

    if (actionsResult.error !== null) {
      return { status: "failed", retryable: true, reason: actionsResult.error.message };
    }

    const skuByAction = new Map((actionsResult.data as ActionRow[]).map((a) => [a.id, a.sku_id]));

    const pendingWork: { decisionId: string; window: number; skuId: string | null }[] = [];

    for (const decision of decisions) {
      const pending = computePendingOutcomeWindows(
        new Date(decision.created_at),
        now,
        measuredByDecision.get(decision.id) ?? [],
      );

      for (const window of pending) {
        pendingWork.push({
          decisionId: decision.id,
          window,
          skuId: skuByAction.get(decision.action_id) ?? null,
        });
      }
    }

    if (pendingWork.length === 0) {
      context.logger.info("measure_decision_outcomes_done", { organization_id: organizationId, measured: 0 });

      return { status: "done", processed: 0 };
    }

    const rows: {
      organization_id: string;
      action_decision_id: string;
      window_days: number;
      outcome_snapshot: Json;
    }[] = [];

    for (const work of pendingWork) {
      let snapshot: Json = {};

      if (work.skuId !== null) {
        const snapshotResult = await deps.db.rpc("get_sku_decision_snapshot", {
          p_organization_id: organizationId,
          p_sku_id: work.skuId,
          p_as_of: asOf,
        });

        if (snapshotResult.error !== null) {
          return { status: "failed", retryable: true, reason: snapshotResult.error.message };
        }

        snapshot = snapshotResult.data;
      }

      rows.push({
        organization_id: organizationId,
        action_decision_id: work.decisionId,
        window_days: work.window,
        outcome_snapshot: snapshot,
      });
    }

    const insertResult = await deps.db
      .from("action_outcomes")
      .upsert(rows, { onConflict: "action_decision_id,window_days", ignoreDuplicates: true });

    if (insertResult.error !== null) {
      return { status: "failed", retryable: true, reason: insertResult.error.message };
    }

    context.logger.info("measure_decision_outcomes_done", {
      organization_id: organizationId,
      measured: rows.length,
    });

    return { status: "done", processed: rows.length };
  };
}
