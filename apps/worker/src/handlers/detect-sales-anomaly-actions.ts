import type { AdminClient, Json } from "@sb/db";
import { diagnoseSalesAnomaly, estimateImpactBrl, shiftBusinessDate, toSalesMetricDate } from "@sb/domain";
import type { CorrelatedEvent, SalesAnomalyDiagnosis, SalesBaselineSignal } from "@sb/domain";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";

/**
 * `diagnostics.detect-sales-anomalies` — Central de Ações (Fase 6, D-064),
 * segunda metade de `diagnoseSalesAnomaly`: a mesma função pura já roda ao
 * vivo em `/diagnostico` (uma página, um request); este job PERSISTE o
 * mesmo diagnóstico como item acionável em `actions`, em lote, uma vez por
 * dia.
 *
 * Escreve direto em `actions` via `service_role` (sem RPC) — mesmo padrão de
 * `recordDomainEvents`: o worker já é confiável (autorização é "esta
 * organização existe", não "este usuário tem permissão"). `update_action_status`
 * (RPC security definer) existe para o navegador, não para o próprio backend.
 *
 * **Por organização**, não por conta ML — SKU é organizacional (D-006),
 * mesmo raciocínio de `verify-ledger-integrity`.
 *
 * Severidade espelha confiança nesta primeira fatia: não há ainda base
 * evidencial para um limiar de severidade por valor em R$ (diferente do
 * z-score, que é convenção estatística padrão) — `docs/DECISIONS.md` D-064.
 */

const payloadSchema = z.object({ organizationId: z.uuid() });

export interface DetectSalesAnomalyActionsDeps {
  db: AdminClient;
  now?: () => Date;
}

interface BaselineRow {
  sku_id: string;
  sku: string;
  title: string | null;
  weekday: number;
  current_units_sold: number;
  baseline_mean: number;
  baseline_stddev: number;
  sample_count: number;
}

interface AveragePriceRow {
  sku_id: string;
  average_price: number;
}

const CORRELATION_WINDOW_DAYS_BEFORE = 3;
const CORRELATION_WINDOW_DAYS_AFTER = 1;

/** Janela para o preço médio de impacto — mais larga que a de correlação de eventos: aqui o objetivo é um preço representativo, não um instante. */
const AVERAGE_PRICE_WINDOW_DAYS = 30;

function toSignal(row: BaselineRow): SalesBaselineSignal {
  return {
    skuId: row.sku_id,
    sku: row.sku,
    title: row.title,
    weekday: row.weekday,
    currentUnitsSold: row.current_units_sold,
    baselineMean: row.baseline_mean,
    baselineStddev: row.baseline_stddev,
    sampleCount: row.sample_count,
  };
}

function toEvidence(diagnosis: SalesAnomalyDiagnosis): Json {
  return {
    direcao: diagnosis.direcao,
    z_score: diagnosis.zScore,
    units_delta: diagnosis.unitsDelta,
    evidencias: diagnosis.evidencias.map((item) => ({ tipo: item.tipo, descricao: item.descricao })),
    causas_candidatas: diagnosis.causasCandidatas.map((cause) => ({
      event_type: cause.eventType,
      occurred_at: cause.occurredAt.toISOString(),
      descricao: cause.descricao,
    })),
  };
}

export function createDetectSalesAnomalyActionsHandler(deps: DetectSalesAnomalyActionsDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem organizationId" };
    }

    const { organizationId } = parsed.data;
    const now = deps.now?.() ?? new Date();
    const asOf = shiftBusinessDate(toSalesMetricDate(now), -1);

    const baseline = await deps.db.rpc("get_sku_sales_baseline", {
      p_organization_id: organizationId,
      p_as_of: asOf,
    });

    if (baseline.error !== null) {
      return { status: "failed", retryable: true, reason: baseline.error.message };
    }

    const signals = baseline.data as BaselineRow[];

    // Primeira passada sem eventos: só para achar QUAIS SKUs são anomalia,
    // evitando buscar domain_events/preço de SKU nenhum sem necessidade —
    // mesmo raciocínio de `/diagnostico/page.tsx`.
    const candidateSkuIds = signals
      .filter((row) => diagnoseSalesAnomaly(organizationId, toSignal(row), asOf, []) !== null)
      .map((row) => row.sku_id);

    if (candidateSkuIds.length === 0) {
      context.logger.info("detect_sales_anomaly_actions_done", { organization_id: organizationId, actions: 0 });

      return { status: "done", processed: 0 };
    }

    const windowStart = shiftBusinessDate(asOf, -CORRELATION_WINDOW_DAYS_BEFORE);
    const windowEnd = shiftBusinessDate(asOf, CORRELATION_WINDOW_DAYS_AFTER);

    const eventsResult = await deps.db
      .from("domain_events")
      .select("entity_id, event_type, occurred_at")
      .eq("organization_id", organizationId)
      .eq("entity_type", "sku")
      .in("entity_id", candidateSkuIds)
      .gte("occurred_at", windowStart)
      .lt("occurred_at", windowEnd);

    if (eventsResult.error !== null) {
      return { status: "failed", retryable: true, reason: eventsResult.error.message };
    }

    const eventsBySku = new Map<string, CorrelatedEvent[]>();

    for (const event of eventsResult.data) {
      const list = eventsBySku.get(event.entity_id) ?? [];
      list.push({ eventType: event.event_type, occurredAt: new Date(event.occurred_at) });
      eventsBySku.set(event.entity_id, list);
    }

    // D-116 — SAC como evidência: reclamações ABERTAS vinculadas aos SKUs
    // candidatos. Só para candidatos (mesma economia de N+1 dos eventos), e
    // falha aqui degrada para "sem sinal de SAC" em vez de derrubar o
    // diagnóstico: a evidência é adicional por definição.
    const openClaimsBySku = new Map<string, Set<string>>();

    const claimLinks = await deps.db
      .from("support_case_links")
      .select("sku_id, support_case_id, support_cases!inner(internal_status, channel)")
      .eq("organization_id", organizationId)
      .in("sku_id", candidateSkuIds)
      .eq("support_cases.channel", "CLAIM")
      .neq("support_cases.internal_status", "RESOLVIDO");

    if (claimLinks.error === null) {
      for (const link of claimLinks.data as unknown as { sku_id: string | null; support_case_id: string }[]) {
        if (link.sku_id === null) continue;

        const set = openClaimsBySku.get(link.sku_id) ?? new Set<string>();

        set.add(link.support_case_id);
        openClaimsBySku.set(link.sku_id, set);
      }
    } else {
      context.logger.warn("sales_anomaly_support_signal_failed", { reason: claimLinks.error.message });
    }

    const pricesResult = await deps.db.rpc("get_sku_average_prices", {
      p_organization_id: organizationId,
      p_sku_ids: candidateSkuIds,
      p_date_from: shiftBusinessDate(asOf, -AVERAGE_PRICE_WINDOW_DAYS),
      p_date_to: asOf,
    });

    if (pricesResult.error !== null) {
      return { status: "failed", retryable: true, reason: pricesResult.error.message };
    }

    const averagePriceBySku = new Map(
      (pricesResult.data as AveragePriceRow[]).map((row) => [row.sku_id, row.average_price]),
    );

    const diagnoses: SalesAnomalyDiagnosis[] = [];

    for (const row of signals) {
      const diagnosis = diagnoseSalesAnomaly(organizationId, toSignal(row), asOf, eventsBySku.get(row.sku_id) ?? [], {
        openClaims: openClaimsBySku.get(row.sku_id)?.size ?? 0,
      });

      if (diagnosis !== null) {
        diagnoses.push(diagnosis);
      }
    }

    const rows = diagnoses.map((diagnosis) => ({
      organization_id: organizationId,
      kind: "venda_anomala",
      severity: diagnosis.confianca,
      confidence: diagnosis.confianca,
      estimated_impact_brl: estimateImpactBrl(
        diagnosis.unitsDelta,
        averagePriceBySku.get(diagnosis.escopo.skuId) ?? null,
      ),
      sku_id: diagnosis.escopo.skuId,
      evidence: toEvidence(diagnosis),
      recommendation: diagnosis.proximosPassos.join(" "),
      created_by: "system",
      dedup_key: `sales_anomaly:${diagnosis.escopo.skuId}:${asOf}`,
    }));

    if (rows.length > 0) {
      const upsertResult = await deps.db.from("actions").upsert(rows, { onConflict: "organization_id,dedup_key" });

      if (upsertResult.error !== null) {
        return { status: "failed", retryable: true, reason: upsertResult.error.message };
      }
    }

    context.logger.info("detect_sales_anomaly_actions_done", {
      organization_id: organizationId,
      signals: signals.length,
      actions: rows.length,
    });

    return { status: "done", processed: rows.length };
  };
}
