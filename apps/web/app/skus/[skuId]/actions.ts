"use server";

import { diagnoseSalesAnomaly, estimateImpactBrl, shiftBusinessDate, toSalesMetricDate } from "@sb/domain";
import type { CorrelatedEvent, SalesAnomalyDiagnosis } from "@sb/domain";

import { createClient } from "../../../lib/supabase/server";

/**
 * Ação contextual "O que aconteceu?" (Fase 7, item 8, D-078,
 * `docs/PRODUCT_REQUIREMENTS.md`) — mesmo motor de `/diagnostico` e do job
 * diário da Central de Ações (D-064), só que sob demanda para UM SKU só.
 * Nenhuma agregação nova: `get_sku_sales_baseline` (ganhou `p_sku_id`
 * opcional em D-078) + `diagnoseSalesAnomaly`, ambos já existentes e
 * testados — esta função só orquestra as mesmas chamadas.
 */

const CORRELATION_WINDOW_DAYS_BEFORE = 3;
const CORRELATION_WINDOW_DAYS_AFTER = 1;
const AVERAGE_PRICE_WINDOW_DAYS = 30;

export type SkuDiagnosisStatus = "insufficient_sample" | "no_anomaly" | "anomaly";

export type SkuDiagnosisResult =
  | { ok: true; status: SkuDiagnosisStatus; diagnosis: SalesAnomalyDiagnosis | null; impactBrl: number | null }
  | { ok: false; message: string };

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

export async function diagnoseSku(skuId: string): Promise<SkuDiagnosisResult> {
  const supabase = await createClient();

  const sku = await supabase.from("skus").select("organization_id").eq("id", skuId).maybeSingle();

  if (sku.error !== null || sku.data === null) {
    return { ok: false, message: "SKU não encontrado." };
  }

  const organizationId = sku.data.organization_id;
  // Ontem, não hoje — daily_sku_metrics de hoje ainda está incompleto,
  // mesmo raciocínio de /diagnostico e /vendas sobre frescor de cálculo.
  const asOf = shiftBusinessDate(toSalesMetricDate(new Date()), -1);

  const baseline = await supabase.rpc("get_sku_sales_baseline", {
    p_organization_id: organizationId,
    p_as_of: asOf,
    p_sku_id: skuId,
  });

  if (baseline.error !== null) {
    return { ok: false, message: "Não foi possível calcular o baseline de vendas." };
  }

  const [row] = baseline.data as BaselineRow[];

  // A RPC já filtra amostra mínima (>= 4 ocorrências do mesmo dia da
  // semana) — SKU sem linha aqui significa histórico curto demais para um
  // desvio padrão confiável, não "sem venda".
  if (row === undefined) {
    return { ok: true, status: "insufficient_sample", diagnosis: null, impactBrl: null };
  }

  const windowStart = shiftBusinessDate(asOf, -CORRELATION_WINDOW_DAYS_BEFORE);
  const windowEnd = shiftBusinessDate(asOf, CORRELATION_WINDOW_DAYS_AFTER);

  const eventsResult = await supabase
    .from("domain_events")
    .select("event_type, occurred_at")
    .eq("organization_id", organizationId)
    .eq("entity_type", "sku")
    .eq("entity_id", skuId)
    .gte("occurred_at", windowStart)
    .lt("occurred_at", windowEnd);

  if (eventsResult.error !== null) {
    // Mesmo cuidado de /diagnostico (D-067): falha ao ler domain_events não
    // pode virar "nenhuma causa candidata" silenciosamente — a causa real
    // podia existir e só não foi lida.
    return { ok: false, message: "Não foi possível verificar eventos correlatos." };
  }

  const relatedEvents: CorrelatedEvent[] = eventsResult.data.map((event) => ({
    eventType: event.event_type,
    occurredAt: new Date(event.occurred_at),
  }));

  const diagnosis = diagnoseSalesAnomaly(
    organizationId,
    {
      skuId: row.sku_id,
      sku: row.sku,
      title: row.title,
      weekday: row.weekday,
      currentUnitsSold: row.current_units_sold,
      baselineMean: row.baseline_mean,
      baselineStddev: row.baseline_stddev,
      sampleCount: row.sample_count,
    },
    asOf,
    relatedEvents,
  );

  if (diagnosis === null) {
    return { ok: true, status: "no_anomaly", diagnosis: null, impactBrl: null };
  }

  // Preço médio é informação SECUNDÁRIA do card — diagnóstico principal já
  // está pronto. Falha aqui vira "impacto desconhecido" (nunca zero
  // fingido, mesma regra de estimateImpactBrl), não bloqueia a resposta.
  const pricesResult = await supabase.rpc("get_sku_average_prices", {
    p_organization_id: organizationId,
    p_sku_ids: [skuId],
    p_date_from: shiftBusinessDate(asOf, -AVERAGE_PRICE_WINDOW_DAYS),
    p_date_to: asOf,
  });

  const averagePrice = pricesResult.data?.[0]?.average_price ?? null;
  const impactBrl = estimateImpactBrl(diagnosis.unitsDelta, averagePrice);

  return { ok: true, status: "anomaly", diagnosis, impactBrl };
}
