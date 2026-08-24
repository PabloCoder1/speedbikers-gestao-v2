"use client";

import { useState, type ReactNode } from "react";

import { formatCurrency } from "../../lib/format";
import { claimAction, dismissAction, resolveAction } from "./actions";

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

  return (
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
          </div>
        )}
        {error !== null && (
          <p role="alert" style={{ margin: "0.25rem 0 0", fontSize: "0.75rem", color: "var(--sb-danger)" }}>
            {error}
          </p>
        )}
      </td>
    </tr>
  );
}
