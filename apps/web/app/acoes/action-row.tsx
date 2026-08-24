"use client";

import { useState, type ReactNode } from "react";

import { formatCurrency } from "../../lib/format";
import { claimAction, dismissAction, registerDecision, resolveAction } from "./actions";

/**
 * Uma linha da Central de Ações (Fase 6, D-064) — mesmo padrão de
 * `apps/web/app/vinculacoes/candidate-row.tsx`: componente cliente por linha
 * (estado local de "ocupado"/erro), Server Action por clique.
 */

interface EvidenceItem {
  tipo: string;
  descricao: string;
}

interface CandidateCause {
  event_type: string;
  occurred_at: string;
  descricao: string;
}

export interface ActionEvidence {
  direcao: "queda" | "alta";
  z_score: number;
  units_delta: number;
  evidencias: EvidenceItem[];
  causas_candidatas: CandidateCause[];
}

export interface OutcomeData {
  windowDays: number;
  outcomeSnapshot: Record<string, unknown>;
  measuredAt: string;
}

export interface DecisionData {
  id: string;
  decision: string;
  baselineSnapshot: Record<string, unknown>;
  createdAt: string;
  outcomes: OutcomeData[];
}

export interface ActionRowData {
  id: string;
  sku: string | null;
  title: string | null;
  severity: string;
  confidence: string;
  estimated_impact_brl: number | null;
  evidence: ActionEvidence;
  recommendation: string;
  status: string;
  assignee_id: string | null;
  decisions: DecisionData[];
}

const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
  verticalAlign: "top",
};

const buttonStyle: React.CSSProperties = {
  padding: "0.25rem 0.625rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  background: "transparent",
  fontSize: "0.75rem",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

function statusLabel(status: string): string {
  switch (status) {
    case "novo":
      return "Novo";
    case "em_andamento":
      return "Em andamento";
    case "resolvido":
      return "Resolvido";
    case "descartado":
      return "Descartado";
    default:
      return status;
  }
}

function windowLabel(days: number): string {
  return `${String(days)} dias depois`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR");
}

/**
 * Comparação BRUTA lado a lado, nunca uma % sintetizada — mesmo raciocínio
 * já usado em `/vendas` (D-050-adjacent): `avg_price_7d`/outros podem faltar
 * (SKU sem venda no período), `—` em vez de inventar zero.
 */
function formatSnapshot(snapshot: Record<string, unknown>): string {
  if (Object.keys(snapshot).length === 0) return "Sem dado (ação sem SKU vinculado).";

  const unitsSold = snapshot.units_sold_7d;
  const avgPrice = snapshot.avg_price_7d;
  const stockLocal = snapshot.stock_local;

  const priceText = typeof avgPrice === "number" ? formatCurrency(avgPrice) : "—";

  return `Vendido (7d): ${String(unitsSold)} · Preço médio: ${priceText} · Estoque local: ${String(stockLocal)}`;
}

export function ActionRow({ action, userId }: { action: ActionRowData; userId: string }): ReactNode {
  const [status, setStatus] = useState(action.status);
  const [assigneeId, setAssigneeId] = useState(action.assignee_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(
    fn: () => Promise<{ ok: boolean; message: string | null }>,
    next: string,
    nextAssigneeId?: string,
  ): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await fn();

    if (!result.ok) {
      setError(result.message);
      setBusy(false);

      return;
    }

    setStatus(next);
    if (nextAssigneeId !== undefined) setAssigneeId(nextAssigneeId);
    setBusy(false);
  }

  async function handleRegisterDecision(): Promise<void> {
    const decision = window.prompt("Qual foi a decisão para esta ação?");

    if (decision === null || decision.trim() === "") return;

    setBusy(true);
    setError(null);

    const result = await registerDecision(action.id, decision.trim());

    setBusy(false);

    if (!result.ok) {
      setError(result.message);
    }
  }

  return (
    <>
    <tr style={action.evidence.direcao === "queda" ? { background: "#fdeaea" } : { background: "#e6f4ea" }}>
      <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
        {action.sku ?? "—"}
        {action.title !== null && (
          <div style={{ fontFamily: "inherit", color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
            {action.title}
          </div>
        )}
      </td>
      <td style={td}>{action.evidence.direcao === "queda" ? "Queda" : "Alta"}</td>
      <td style={td}>{action.confidence === "alta" ? "Alta" : "Média"}</td>
      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {formatCurrency(action.estimated_impact_brl)}
      </td>
      <td style={td}>
        {action.evidence.evidencias.map((item) => item.descricao).join(" ")}
        {action.evidence.causas_candidatas.length > 0 && (
          <div style={{ marginTop: "0.25rem", color: "var(--sb-text-soft)" }}>
            {action.evidence.causas_candidatas.map((cause) => cause.descricao).join(" ")}
          </div>
        )}
      </td>
      <td style={td}>{action.recommendation}</td>
      <td style={td}>
        {statusLabel(status)}
        {assigneeId !== null && (
          <div style={{ color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
            {assigneeId === userId ? "Atribuído a você" : "Atribuído"}
          </div>
        )}
      </td>
      <td style={td}>
        {(status === "novo" || status === "em_andamento") && (
          <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
            {status === "novo" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void run(() => claimAction(action.id, userId), "em_andamento", userId);
                }}
                style={buttonStyle}
              >
                Assumir
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void run(() => resolveAction(action.id), "resolvido");
              }}
              style={buttonStyle}
            >
              Resolver
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void run(() => dismissAction(action.id), "descartado");
              }}
              style={buttonStyle}
            >
              Descartar
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void handleRegisterDecision();
              }}
              style={buttonStyle}
            >
              Registrar decisão
            </button>
          </div>
        )}
        {error !== null && (
          <p role="alert" style={{ margin: "0.25rem 0 0", fontSize: "0.75rem", color: "var(--sb-danger)" }}>
            {error}
          </p>
        )}
      </td>
    </tr>

    {action.decisions.length > 0 && (
      <tr style={{ background: "var(--sb-bg-soft, #f7f7f8)" }}>
        <td colSpan={8} style={{ ...td, fontSize: "0.8125rem" }}>
          {action.decisions.map((decision) => (
            <div key={decision.id} style={{ marginBottom: "0.5rem" }}>
              <div>
                <strong>Decisão ({formatDate(decision.createdAt)}):</strong> {decision.decision}
              </div>
              <div style={{ color: "var(--sb-text-soft)", marginTop: "0.125rem" }}>
                No momento da decisão — {formatSnapshot(decision.baselineSnapshot)}
              </div>
              {decision.outcomes.map((outcome) => (
                <div
                  key={outcome.windowDays}
                  style={{ color: "var(--sb-text-soft)", marginTop: "0.125rem" }}
                >
                  {windowLabel(outcome.windowDays)} ({formatDate(outcome.measuredAt)}) —{" "}
                  {formatSnapshot(outcome.outcomeSnapshot)}
                </div>
              ))}
            </div>
          ))}
        </td>
      </tr>
    )}
    </>
  );
}
