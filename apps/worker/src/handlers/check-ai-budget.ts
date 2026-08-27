import type { AdminClient } from "@sb/db";
import { evaluateAiBudget, toSalesMetricDate } from "@sb/domain";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { recordDomainEvents } from "./domain-events.js";

/**
 * Aviso de orçamento de IA (D-100), job `maintenance.check-ai-budget` — o
 * mecanismo que faltava desde D-082: soma `ai_runs.cost_usd` do mês de
 * negócio corrente (`get_ai_monthly_cost_usd`, soma em SQL) e, ultrapassado
 * o teto, emite `ai.budget.exceeded` — que o fan-out de D-073 transforma em
 * notificação durável + toast. "Avisa, não bloqueia": nenhuma chamada de
 * LLM é impedida em nenhum caso.
 *
 * **Por organização, não por conta ML** — custo de IA é organizacional,
 * mesmo raciocínio de `verify-ledger-integrity`. Evento organizacional
 * (`ml_account_id` nulo) alcança TODOS os membros, não só ADMIN — desvio
 * consciente do texto de D-082 ("avisa o ADMIN"), registrado em D-100: o
 * fan-out não filtra por papel para evento sem conta, e restringir exigiria
 * regra por tipo de evento na trigger; quem não quiser recebê-lo silencia
 * por `notification_preferences` (D-076).
 *
 * Um aviso por organização por mês: o dedup_key do evento embute o mês
 * (`@sb/domain`, `evaluateAiBudget`) e `domain_events.dedup_key` é UNIQUE —
 * as rodadas diárias seguintes do mesmo mês deduplicam em silêncio.
 */

const payloadSchema = z.object({ organizationId: z.uuid() });

export interface CheckAiBudgetDeps {
  db: AdminClient;
  /** Teto mensal em USD (D-082 fixou R$100/mês; a conversão está documentada em `apps/worker/src/env.ts`). */
  budgetUsd: number;
  now?: () => Date;
}

export function createCheckAiBudgetHandler(deps: CheckAiBudgetDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem organizationId" };
    }

    const { organizationId } = parsed.data;
    const now = deps.now?.() ?? new Date();

    // Mês de NEGÓCIO (America/Sao_Paulo), não UTC — mesma convenção de todo
    // o resto do projeto (D-050). Offset fixo -03:00: o Brasil não tem
    // horário de verão desde 2019.
    const month = toSalesMetricDate(now).slice(0, 7);
    const monthStartIso = `${month}-01T00:00:00-03:00`;

    // `as never`: a RPC ainda não existe em `packages/db/src/types.ts`
    // (regenerar depois da migration aplicada no Dev — mesma situação e
    // mesma solução temporária de D-077 para `ai_runs`).
    const result = await deps.db.rpc("get_ai_monthly_cost_usd" as never, {
      p_organization_id: organizationId,
      p_from: monthStartIso,
      p_to: now.toISOString(),
    } as never);

    if (result.error !== null) {
      return { status: "failed", retryable: true, reason: result.error.message };
    }

    // `numeric` do Postgres pode chegar como string pelo PostgREST.
    const monthCostUsd = Number((result.data as string | number | null) ?? 0);

    if (!Number.isFinite(monthCostUsd)) {
      return { status: "failed", retryable: true, reason: "soma de custo veio não numérica" };
    }

    const draft = evaluateAiBudget(
      { organizationId, month, monthCostUsd, budgetUsd: deps.budgetUsd },
      now,
    );

    if (draft !== null) {
      await recordDomainEvents(deps.db, { organizationId }, [draft], context.logger);
    }

    context.logger.info("ai_budget_checked", {
      organization_id: organizationId,
      month,
      month_cost_usd: monthCostUsd,
      budget_usd: deps.budgetUsd,
      exceeded: draft !== null,
    });

    return { status: "done", processed: draft !== null ? 1 : 0 };
  };
}
