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

  if (membership.error !== null) {
    // Distinto de "sem organização": aquela mensagem sugere problema de
    // cadastro; isto é falha de leitura transitória (D-067, Nível 3).
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Diagnóstico</h1>
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível confirmar sua organização: {membership.error.message}
        </p>
      </Shell>
    );
  }

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

  // D-116 — SAC como evidência: reclamações ABERTAS por SKU candidato, sob
  // a MESMA RLS da tela. Falha degrada para "sem sinal de SAC" (evidência
  // adicional nunca derruba o diagnóstico).
  const openClaimsBySku = new Map<string, Set<string>>();

  // Eram DOIS `if (candidateSkuIds.length > 0)` seguidos, cada um com sua
  // leitura, e a segunda esperava a primeira sem usar nada dela (D-197). A
  // condição é a mesma e as duas leituras partem do mesmo `candidateSkuIds`:
  // um `if` só, com as duas juntas. Sem anomalia nenhuma o custo era zero
  // antes e continua zero agora — o ganho aparece justamente nas visitas em
  // que a tela tem algo a mostrar.
  //
  // Aqui não cabe embed: um dos lados é RPC, o outro é tabela.
  if (candidateSkuIds.length > 0) {
    const windowStart = shiftBusinessDate(asOf, -CORRELATION_WINDOW_DAYS_BEFORE);
    const windowEnd = shiftBusinessDate(asOf, CORRELATION_WINDOW_DAYS_AFTER);

    const [eventsResult, claimLinks] = await Promise.all([
      // D-152: a correlação deixou de filtrar entity_type='sku' — a RPC mapeia
      // também eventos de ANÚNCIO (preço/título/status, via listings) e de
      // PEDIDO (cancelamento/devolução, via order_items congelados) ao SKU.
      // Mesmo raciocínio nos outros dois consumidores (painel do SKU e worker).
      supabase.rpc("get_sku_correlated_events", {
        p_organization_id: organizationId,
        p_sku_ids: candidateSkuIds,
        p_from: windowStart,
        p_to: windowEnd,
      }),
      supabase
        .from("support_case_links")
        .select("sku_id, support_case_id, support_cases!inner(internal_status, channel)")
        .in("sku_id", candidateSkuIds)
        .eq("support_cases.channel", "CLAIM")
        .neq("support_cases.internal_status", "RESOLVIDO"),
    ]);

    eventsError = eventsResult.error;

    for (const event of eventsResult.data ?? []) {
      const list = eventsBySku.get(event.sku_id) ?? [];
      list.push({ eventType: event.event_type, occurredAt: new Date(event.occurred_at) });
      eventsBySku.set(event.sku_id, list);
    }

    for (const link of (claimLinks.data ?? []) as unknown as { sku_id: string | null; support_case_id: string }[]) {
      if (link.sku_id === null) continue;

      const set = openClaimsBySku.get(link.sku_id) ?? new Set<string>();

      set.add(link.support_case_id);
      openClaimsBySku.set(link.sku_id, set);
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
      { openClaims: openClaimsBySku.get(row.sku_id)?.size ?? 0 },
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
