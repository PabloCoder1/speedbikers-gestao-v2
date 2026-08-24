import { diagnoseSalesAnomaly, shiftBusinessDate, toSalesMetricDate } from "@sb/domain";
import type { CorrelatedEvent, SalesAnomalyDiagnosis } from "@sb/domain";
import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { formatBusinessDate, formatCount } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Diagnóstico — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Primeira fatia da Fase 6 (Diagnóstico e Ações, `docs/ARCHITECTURE.md`
 * secao 16) — "Baseline, desvio e detecção estatística sem machine
 * learning" + "Correlação com domain_events datados" + "Contrato de
 * diagnóstico com evidências e confiança". "Central de Ações" (persistir o
 * diagnóstico como item acionável) e "Decisões com baseline_snapshot"
 * ficam para as próximas fatias da mesma fase — dependem desta existir
 * primeiro.
 *
 * `asOf` é ONTEM, não hoje — `daily_sku_metrics` de hoje ainda está
 * incompleto (mesmo raciocínio de `/vendas` sobre frescor de cálculo).
 * `get_sku_sales_baseline` faz toda a agregação em SQL (docs/ARCHITECTURE.md
 * secao 21); a interpretação (é anomalia? qual a causa?) é
 * `diagnoseSalesAnomaly`, pura, em `@sb/domain/diagnostics`.
 */

/**
 * `title` é anulável de verdade (`skus.title`), mas o gerador de tipos do
 * Supabase não infere nulidade em coluna de retorno de RPC — mesma lacuna
 * já documentada em `/cobertura`/`/curva-abc`.
 */
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

const CORRELATION_WINDOW_DAYS_BEFORE = 3;
const CORRELATION_WINDOW_DAYS_AFTER = 1;

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--sb-text-soft)",
  whiteSpace: "nowrap",
};

const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
  verticalAlign: "top",
};

const tdNumber: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

export default async function DiagnosticoPage(): Promise<ReactNode> {
  const supabase = await createClient();

  const membership = await supabase.from("organization_members").select("organization_id").maybeSingle();
  const organizationId = membership.data?.organization_id ?? null;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Diagnóstico</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const asOf = shiftBusinessDate(toSalesMetricDate(new Date()), -1);

  const { data, error: baselineError } = await supabase.rpc("get_sku_sales_baseline", {
    p_organization_id: organizationId,
    p_as_of: asOf,
  });

  const signals = (data ?? []) as BaselineRow[];

  // Primeira passada, sem eventos: só para achar QUAIS SKUs são anomalia,
  // evitando buscar domain_events de SKU nenhum sem necessidade.
  const candidateSkuIds = signals
    .filter(
      (row) =>
        diagnoseSalesAnomaly(
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
          [],
        ) !== null,
    )
    .map((row) => row.sku_id);

  const eventsBySku = new Map<string, CorrelatedEvent[]>();
  let eventsError: { message: string } | null = null;

  if (candidateSkuIds.length > 0) {
    const windowStart = shiftBusinessDate(asOf, -CORRELATION_WINDOW_DAYS_BEFORE);
    const windowEnd = shiftBusinessDate(asOf, CORRELATION_WINDOW_DAYS_AFTER);

    const eventsResult = await supabase
      .from("domain_events")
      .select("entity_id, event_type, occurred_at")
      .eq("organization_id", organizationId)
      .eq("entity_type", "sku")
      .in("entity_id", candidateSkuIds)
      .gte("occurred_at", windowStart)
      .lt("occurred_at", windowEnd);

    eventsError = eventsResult.error;

    for (const event of eventsResult.data ?? []) {
      const list = eventsBySku.get(event.entity_id) ?? [];
      list.push({ eventType: event.event_type, occurredAt: new Date(event.occurred_at) });
      eventsBySku.set(event.entity_id, list);
    }
  }

  // Falha ao ler domain_events ficava invisível antes: o diagnóstico
  // reportava "nenhuma causa candidata encontrada" com confiança normal,
  // quando a causa real podia existir e só não foi lida (D-067).
  const error = baselineError ?? eventsError;

  const diagnoses: SalesAnomalyDiagnosis[] = [];

  for (const row of signals) {
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
      eventsBySku.get(row.sku_id) ?? [],
    );

    if (diagnosis !== null) {
      diagnoses.push(diagnosis);
    }
  }

  const skuLookup = new Map(signals.map((row) => [row.sku_id, row]));

  diagnoses.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Diagnóstico</h1>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Venda de {formatBusinessDate(asOf)} comparada ao baseline do mesmo dia da semana (últimas 8 ocorrências,
        média ± desvio padrão). Sem machine learning — estatística e correlação com eventos registrados
        (`domain_events`). {formatCount(diagnoses.length)} anomalia(s) encontrada(s) entre{" "}
        {formatCount(signals.length)} SKU(s) com histórico suficiente.
      </p>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && diagnoses.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>Nenhuma anomalia detectada.</p>
      )}

      {error === null && diagnoses.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "56rem" }}>
            <thead>
              <tr>
                <th style={th}>SKU</th>
                <th style={th}>Direção</th>
                <th style={th}>Confiança</th>
                <th style={th}>Vendido</th>
                <th style={th}>Baseline</th>
                <th style={th}>Causa candidata</th>
                <th style={th}>Próximos passos</th>
              </tr>
            </thead>

            <tbody>
              {diagnoses.map((diagnosis) => {
                const row = skuLookup.get(diagnosis.escopo.skuId);

                return (
                  <tr
                    key={diagnosis.escopo.skuId}
                    style={diagnosis.direcao === "queda" ? { background: "#fdeaea" } : { background: "#e6f4ea" }}
                  >
                    <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                      {row?.sku}
                      {row?.title !== null && row?.title !== undefined && (
                        <div style={{ fontFamily: "inherit", color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
                          {row.title}
                        </div>
                      )}
                    </td>
                    <td style={td}>{diagnosis.direcao === "queda" ? "Queda" : "Alta"}</td>
                    <td style={td}>{diagnosis.confianca === "alta" ? "Alta" : "Média"}</td>
                    <td style={tdNumber}>{row?.current_units_sold}</td>
                    <td style={tdNumber}>
                      {row?.baseline_mean} ± {row?.baseline_stddev}
                    </td>
                    <td style={td}>
                      {diagnosis.causasCandidatas.length === 0
                        ? "—"
                        : diagnosis.causasCandidatas.map((cause) => cause.descricao).join(" ")}
                    </td>
                    <td style={td}>{diagnosis.proximosPassos.join(" ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
