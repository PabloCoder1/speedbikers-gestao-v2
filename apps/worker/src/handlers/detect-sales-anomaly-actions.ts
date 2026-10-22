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
 *
 * **Por canal (C-83, D-639, decisão do dono em 22/10):** a linha de base vem
 * por SKU E canal (Mercado Livre e Shopee), e cada canal é avaliado separado
 * — uma queda no ML vira ação mesmo que a Shopee compense, e a ação diz o
 * canal (`evidence.marketplace`). Os eventos do SKU valem para os dois canais;
 * os do anúncio e do pedido, só para o canal deles. A reclamação aberta (SAC)
 * é do ML.
 *
 * **Episódio por SKU e canal (D-643, decisão do dono em 22/10):** o handler
 * não grava a ação; manda as detecções do dia a `registrar_vendas_anomalas`,
 * que faz o ciclo da D-403 numa transação (atualiza o aberto, não reabre o
 * fechado por uma pessoa, cria o novo, encerra depois de 3 dias sem detecção
 * e encerra o acumulado de antes). O assunto é `<canal>:<sku>`. O ciclo roda
 * mesmo sem anomalia nenhuma: é ele que envelhece e encerra os episódios.
 */

const payloadSchema = z.object({ organizationId: z.uuid() });

export interface DetectSalesAnomalyActionsDeps {
  db: AdminClient;
  now?: () => Date;
}

/** C-83: os canais avaliados, na mesma chamada para as três RPCs. */
const MARKETPLACES = ["ML", "SHOPEE"] as const;

interface BaselineRow {
  /** C-83: 'ML' | 'SHOPEE'. */
  marketplace: string;
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
  marketplace: string;
}

const chave = (skuId: string, marketplace: string): string => `${skuId}:${marketplace}`;

/** D-643: uma detecção do dia, como `registrar_vendas_anomalas` recebe. */
interface Deteccao {
  subject_key: string;
  severity: string;
  confidence: string;
  impacto: number | null;
  sku_id: string;
  evidence: Json;
  recommendation: string;
}

async function registrarEpisodios(
  deps: DetectSalesAnomalyActionsDeps,
  organizationId: string,
  asOf: string,
  deteccoes: Deteccao[],
): Promise<{ ok: true; ciclo: Json } | { ok: false; reason: string }> {
  const ciclo = await deps.db.rpc("registrar_vendas_anomalas", {
    p_organization_id: organizationId,
    p_hoje: asOf,
    p_detectadas: deteccoes as unknown as Json,
  });

  return ciclo.error === null ? { ok: true, ciclo: ciclo.data } : { ok: false, reason: ciclo.error.message };
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

function toEvidence(diagnosis: SalesAnomalyDiagnosis, marketplace: string): Json {
  return {
    marketplace,
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
      p_marketplaces: [...MARKETPLACES],
    });

    if (baseline.error !== null) {
      return { status: "failed", retryable: true, reason: baseline.error.message };
    }

    const signals = baseline.data as BaselineRow[];

    // Primeira passada sem eventos: só para achar QUAIS SKUs são anomalia,
    // evitando buscar domain_events/preço de SKU nenhum sem necessidade —
    // mesmo raciocínio de `/diagnostico/page.tsx`.
    const candidateSkuIds = [
      ...new Set(
        signals
          .filter((row) => diagnoseSalesAnomaly(organizationId, toSignal(row), asOf, []) !== null)
          .map((row) => row.sku_id),
      ),
    ];

    if (candidateSkuIds.length === 0) {
      // Sem anomalia hoje: o ciclo roda assim mesmo, para envelhecer e
      // encerrar os episódios de antes.
      const vazio = await registrarEpisodios(deps, organizationId, asOf, []);

      if (!vazio.ok) return { status: "failed", retryable: true, reason: vazio.reason };

      context.logger.info("detect_sales_anomaly_actions_done", { organization_id: organizationId, actions: 0, ciclo: vazio.ciclo });

      return { status: "done", processed: 0 };
    }

    const windowStart = shiftBusinessDate(asOf, -CORRELATION_WINDOW_DAYS_BEFORE);
    const windowEnd = shiftBusinessDate(asOf, CORRELATION_WINDOW_DAYS_AFTER);

    // D-152: correlação ampliada — a RPC mapeia também eventos de ANÚNCIO
    // (preço/título/status, via listings) e de PEDIDO (via order_items
    // congelados) ao SKU. Fonte única com /diagnostico e o painel do SKU.
    const eventsResult = await deps.db.rpc("get_sku_correlated_events", {
      p_organization_id: organizationId,
      p_sku_ids: candidateSkuIds,
      p_from: windowStart,
      p_to: windowEnd,
      p_marketplaces: [...MARKETPLACES],
    });

    if (eventsResult.error !== null) {
      return { status: "failed", retryable: true, reason: eventsResult.error.message };
    }

    // Por SKU E canal: o evento do SKU (marketplace nulo) vale para os dois.
    const eventsBySkuAndChannel = new Map<string, CorrelatedEvent[]>();

    for (const event of eventsResult.data) {
      for (const marketplace of event.marketplace === null ? MARKETPLACES : [event.marketplace]) {
        const list = eventsBySkuAndChannel.get(chave(event.sku_id, marketplace)) ?? [];
        list.push({ eventType: event.event_type, occurredAt: new Date(event.occurred_at) });
        eventsBySkuAndChannel.set(chave(event.sku_id, marketplace), list);
      }
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
      for (const link of claimLinks.data) {
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
      p_marketplaces: [...MARKETPLACES],
    });

    if (pricesResult.error !== null) {
      return { status: "failed", retryable: true, reason: pricesResult.error.message };
    }

    const averagePriceBySkuAndChannel = new Map(
      (pricesResult.data as AveragePriceRow[]).map((row) => [chave(row.sku_id, row.marketplace), row.average_price]),
    );

    const diagnoses: { diagnosis: SalesAnomalyDiagnosis; marketplace: string }[] = [];

    for (const row of signals) {
      const diagnosis = diagnoseSalesAnomaly(
        organizationId,
        toSignal(row),
        asOf,
        eventsBySkuAndChannel.get(chave(row.sku_id, row.marketplace)) ?? [],
        // A reclamação aberta é do Mercado Livre.
        { openClaims: row.marketplace === "ML" ? (openClaimsBySku.get(row.sku_id)?.size ?? 0) : 0 },
      );

      if (diagnosis !== null) {
        diagnoses.push({ diagnosis, marketplace: row.marketplace });
      }
    }

    const deteccoes: Deteccao[] = diagnoses.map(({ diagnosis, marketplace }) => ({
      // D-643: o assunto do episódio, um por SKU e canal.
      subject_key: `${marketplace}:${diagnosis.escopo.skuId}`,
      severity: diagnosis.confianca,
      confidence: diagnosis.confianca,
      impacto: estimateImpactBrl(
        diagnosis.unitsDelta,
        averagePriceBySkuAndChannel.get(chave(diagnosis.escopo.skuId, marketplace)) ?? null,
      ),
      sku_id: diagnosis.escopo.skuId,
      evidence: toEvidence(diagnosis, marketplace),
      recommendation: diagnosis.proximosPassos.join(" "),
    }));

    const registro = await registrarEpisodios(deps, organizationId, asOf, deteccoes);

    if (!registro.ok) {
      return { status: "failed", retryable: true, reason: registro.reason };
    }

    context.logger.info("detect_sales_anomaly_actions_done", {
      organization_id: organizationId,
      signals: signals.length,
      actions: deteccoes.length,
      actions_shopee: diagnoses.filter((item) => item.marketplace === "SHOPEE").length,
      ciclo: registro.ciclo,
    });

    return { status: "done", processed: deteccoes.length };
  };
}
