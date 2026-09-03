import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { toneColor } from "../../components/state-pill";
import { formatCount, formatDateTime } from "../../lib/format";
import { mlAccountStatusLabel, statusTone } from "../../lib/labels";
import { sanitizeErrorText } from "../../lib/sanitize";
import { createClient } from "../../lib/supabase/server";
import { classifyResourceFreshness, failureRateLabel } from "../../lib/sync-health";
import type { SyncVerdict } from "../../lib/sync-health";

export const metadata = { title: "Saúde da Sincronização — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Ver apps/web/app/importacoes/page.tsx para o mesmo raciocínio.
export const dynamic = "force-dynamic";

/**
 * Saúde da Sincronização POR RECURSO (Fase 5C, D-143).
 *
 * A versão anterior media o frescor de UM recurso (orders) e contava erros
 * de 24h. Medido antes de reescrever: `visits` falhava 123 de 145 execuções
 * (85%, rate limit 429) e `fulfillment` nunca teve uma rodada `done` — e a
 * tela não mostrava nenhum dos dois.
 *
 * Três verdades que a tela agora separa, porque são três coisas:
 *
 * 1. **Reconciliação** (permanente): o indicador honesto é frescor CONTRA A
 *    CADÊNCIA do job — visits roda 1x/dia, messages a cada 10 min; o mesmo
 *    limiar para os dois carimbaria "atrasada" uma sincronização saudável.
 * 2. **Backfill** (finito): "não rodou nas últimas 24h" é o estado normal de
 *    um backfill concluído. Mostra o cursor (`backfill_covered_until`) e a
 *    conclusão — nunca um selo de atraso, nunca uma porcentagem inventada.
 * 3. **Processamento nosso** (métricas recalculadas): o ML pode estar em dia
 *    e o recálculo parado — é onde os gargalos aparecem (PRD 2026-08-28).
 */

const VERDICT_TONE: Record<SyncVerdict, { color: string; label: string } | null> = {
  ok: { color: "var(--sb-secondary)", label: "Em dia" },
  atencao: { color: "var(--sb-accent-ink)", label: "Atrasando" },
  critico: { color: "var(--sb-danger)", label: "Atrasada" },
  nunca: { color: "var(--sb-muted-ink)", label: "Nunca sincronizado" },
  sem_cadencia: null,
};


const RESOURCE_LABEL: Record<string, string> = {
  orders: "Pedidos",
  listings: "Anúncios",
  visits: "Visitas",
  fulfillment: "Full",
  questions: "Perguntas",
  messages: "Mensagens",
  claims: "Reclamações",
};

const SEVERITY_TONE: Record<string, { color: string; label: string }> = {
  informativo: { color: "var(--sb-muted-ink)", label: "Informativo" },
  importante: { color: "var(--sb-accent-ink)", label: "Importante" },
  critico: { color: "var(--sb-danger)", label: "Crítico" },
};

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
  fontSize: "0.8125rem",
  verticalAlign: "top",
};

const tdNumber: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

interface HealthRow {
  ml_account_id: string;
  account_label: string;
  resource: string;
  channel: string;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_reason: string | null;
  last_success_at: string | null;
  latest_record_at: string | null;
  runs_24h: number;
  failed_24h: number;
  items_24h: number;
}

interface ProcessingRow {
  ml_account_id: string;
  account_label: string;
  latest_metric_date: string | null;
  last_computed_at: string | null;
}

interface EventRow {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  severity: string;
  occurred_at: string;
  ml_accounts: { label: string } | null;
}

export default async function SincronizacaoPage(): Promise<ReactNode> {
  const supabase = await createClient();
  const now = new Date();

  const membership = await supabase.from("organization_members").select("organization_id").maybeSingle();
  const organizationId = membership.data?.organization_id ?? null;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Saúde da Sincronização</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const [accountsResult, healthResult, processingResult, eventsResult] = await Promise.all([
    supabase
      .from("ml_accounts")
      .select("id, label, slug, status, last_error, backfill_covered_until")
      .order("label", { ascending: true }),
    supabase.rpc("get_sync_health", { p_organization_id: organizationId }),
    supabase.rpc("get_processing_health", { p_organization_id: organizationId }),
    supabase
      .from("domain_events")
      .select("id, event_type, entity_type, entity_id, severity, occurred_at, ml_accounts(label)")
      .order("occurred_at", { ascending: false })
      .limit(30),
  ]);

  const accounts = accountsResult.data ?? [];
  const health = (healthResult.data ?? []) as HealthRow[];
  const processing = (processingResult.data ?? []) as ProcessingRow[];
  const events = (eventsResult.data ?? []) as EventRow[];

  // Falha em QUALQUER uma das quatro: mostrar erro, nunca "sem dado" (D-067)
  // — numa tela que existe para pegar exatamente esse tipo de problema.
  const error =
    accountsResult.error ?? healthResult.error ?? processingResult.error ?? eventsResult.error;

  const reconciliation = health.filter((row) => row.channel === "reconciliation");
  const backfill = health.filter((row) => row.channel === "backfill");

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-1)", fontSize: "1.375rem" }}>Saúde da Sincronização</h1>

      <p style={{ margin: "0 0 var(--sb-space-4)", color: "var(--sb-text-soft)", fontSize: "0.9375rem" }}>
        Por conta e por recurso, contra a cadência real de cada job. Reconciliação é permanente (o indicador é
        frescor); backfill é finito (o indicador é o cursor); e o recálculo de métricas é trabalho nosso, medido em
        separado.
      </p>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && (
        <>
          {/* Conexão das contas */}
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: "0 0 var(--sb-space-4)",
              display: "flex",
              flexWrap: "wrap",
              gap: "var(--sb-space-2)",
            }}
          >
            {accounts.map((account) => {
              const tone = { color: toneColor(statusTone(account.status)), label: mlAccountStatusLabel(account.status) };

              return (
                <li
                  key={account.id}
                  style={{
                    border: "1px solid var(--sb-border)",
                    borderLeft: `3px solid ${tone.color}`,
                    borderRadius: "var(--sb-radius)",
                    padding: "0.375rem 0.75rem",
                    fontSize: "0.8125rem",
                    display: "flex",
                    gap: "var(--sb-space-2)",
                    alignItems: "baseline",
                  }}
                >
                  <strong>{account.label}</strong>
                  <span style={{ color: tone.color, fontWeight: 600 }}>{tone.label}</span>
                  {account.status === "ERROR" && account.last_error !== null && (
                    <span style={{ color: "var(--sb-danger)" }}>{sanitizeErrorText(account.last_error)}</span>
                  )}
                </li>
              );
            })}
          </ul>

          {/* Reconciliação: frescor contra a cadência */}
          <h2 style={{ fontSize: "1.0625rem", margin: "0 0 var(--sb-space-2)" }}>
            Sincronização contínua (dado puxado do Mercado Livre)
          </h2>

          <div style={{ overflowX: "auto", marginBottom: "var(--sb-space-4)" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "60rem" }}>
              <thead>
                <tr>
                  <th style={th}>Conta</th>
                  <th style={th}>Recurso</th>
                  <th style={th}>Situação</th>
                  <th style={th}>Último sucesso</th>
                  <th style={th}>Último dado</th>
                  <th style={th}>Itens (24h)</th>
                  <th style={th}>Falhas (24h)</th>
                </tr>
              </thead>
              <tbody>
                {reconciliation.map((row) => {
                  const verdict = classifyResourceFreshness(
                    row.resource,
                    row.channel,
                    row.last_success_at,
                    now,
                  );
                  const tone = VERDICT_TONE[verdict];
                  const failures = failureRateLabel(row.runs_24h, row.failed_24h);

                  return (
                    <tr key={`${row.ml_account_id}:${row.resource}`}>
                      <td style={td}>{row.account_label}</td>
                      <td style={td}>{RESOURCE_LABEL[row.resource] ?? row.resource}</td>
                      <td style={{ ...td, color: tone?.color, fontWeight: tone === null ? undefined : 700 }}>
                        {tone?.label ?? "—"}
                        {/*
                          Falha alta com sucesso recente é estado próprio: o
                          caso real é visits com 85% de falha por 429 e ainda
                          assim um sucesso diário — o frescor fica "Em dia"
                          enquanto a cobertura degrada. O alerta não substitui
                          o veredito; soma-se a ele.
                        */}
                        {failures !== null && (
                          <div style={{ color: "var(--sb-danger)", fontWeight: 400, fontSize: "0.75rem" }}>
                            {failures}
                          </div>
                        )}
                        {row.last_run_status !== null &&
                          row.last_run_status !== "done" &&
                          row.last_run_status !== "partial" &&
                          row.last_run_reason !== null && (
                            <div style={{ color: "var(--sb-text-soft)", fontWeight: 400, fontSize: "0.75rem" }}>
                              última falha: {sanitizeErrorText(row.last_run_reason, 80)}
                            </div>
                          )}
                      </td>
                      <td style={td}>{formatDateTime(row.last_success_at)}</td>
                      <td style={td}>{formatDateTime(row.latest_record_at)}</td>
                      <td style={tdNumber}>{formatCount(row.items_24h)}</td>
                      <td style={{ ...tdNumber, color: row.failed_24h > 0 ? "var(--sb-danger)" : undefined }}>
                        {formatCount(row.failed_24h)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Backfill: finito, sem selo de atraso, sem porcentagem inventada */}
          <h2 style={{ fontSize: "1.0625rem", margin: "0 0 var(--sb-space-2)" }}>Backfill (histórico, finito)</h2>

          <div style={{ overflowX: "auto", marginBottom: "var(--sb-space-4)" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "44rem" }}>
              <thead>
                <tr>
                  <th style={th}>Conta</th>
                  <th style={th}>Recurso</th>
                  <th style={th}>Última execução</th>
                  <th style={th}>Coberto até</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {backfill.map((row) => {
                  const account = accounts.find((a) => a.id === row.ml_account_id);

                  return (
                    <tr key={`${row.ml_account_id}:${row.resource}:bf`}>
                      <td style={td}>{row.account_label}</td>
                      <td style={td}>{RESOURCE_LABEL[row.resource] ?? row.resource}</td>
                      <td style={td}>{formatDateTime(row.last_run_at)}</td>
                      {/*
                        `backfill_covered_until` era gravado e nunca lido — o
                        "ganho barato" do ROADMAP. É o cursor real: até onde a
                        história já foi puxada, sem inventar porcentagem
                        (não existe denominador confiável para "quanto falta").
                      */}
                      <td style={td}>{formatDateTime(account?.backfill_covered_until ?? null)}</td>
                      <td style={td}>{row.last_run_status ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* O lado processado por nós */}
          <h2 style={{ fontSize: "1.0625rem", margin: "0 0 var(--sb-space-2)" }}>
            Métricas recalculadas (dado processado por nós)
          </h2>

          <div style={{ overflowX: "auto", marginBottom: "var(--sb-space-4)" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "36rem" }}>
              <thead>
                <tr>
                  <th style={th}>Conta</th>
                  <th style={th}>Métricas calculadas até</th>
                  <th style={th}>Último recálculo</th>
                </tr>
              </thead>
              <tbody>
                {processing.map((row) => (
                  <tr key={row.ml_account_id}>
                    <td style={td}>{row.account_label}</td>
                    <td style={td}>{row.latest_metric_date ?? "—"}</td>
                    <td style={td}>{formatDateTime(row.last_computed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Eventos recentes — preservado da versão anterior */}
          <h2 style={{ fontSize: "1.0625rem", margin: "0 0 var(--sb-space-2)" }}>Eventos recentes</h2>

          {events.length === 0 && <p style={{ color: "var(--sb-text-soft)" }}>Nenhum evento registrado ainda.</p>}

          {events.length > 0 && (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {events.map((event) => {
                const tone = SEVERITY_TONE[event.severity] ?? {
                  color: "var(--sb-muted-ink)",
                  label: event.severity,
                };

                return (
                  <li
                    key={event.id}
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "baseline",
                      gap: "var(--sb-space-2)",
                      padding: "var(--sb-space-2) 0",
                      borderBottom: "1px solid var(--sb-border)",
                      fontSize: "0.875rem",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "0.6875rem",
                        fontWeight: 700,
                        letterSpacing: "0.04em",
                        color: tone.color,
                        minWidth: "5.5rem",
                      }}
                    >
                      {tone.label.toUpperCase()}
                    </span>
                    <span style={{ fontWeight: 600 }}>{event.event_type}</span>
                    <span
                      style={{
                        color: "var(--sb-text-soft)",
                        fontFamily: "ui-monospace, monospace",
                        fontSize: "0.8125rem",
                      }}
                    >
                      {event.entity_type} {event.entity_id}
                    </span>
                    {/* Nulo para eventos organizacionais sem conta (D-054). */}
                    <span style={{ color: "var(--sb-text-soft)" }}>{event.ml_accounts?.label ?? "Estoque"}</span>
                    <span style={{ color: "var(--sb-text-soft)", marginLeft: "auto", whiteSpace: "nowrap" }}>
                      {formatDateTime(event.occurred_at)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Shell>
  );
}
