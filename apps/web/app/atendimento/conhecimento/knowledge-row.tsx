"use client";

import { useState, type ReactNode } from "react";

import { StatusPill } from "../../../components/status-pill";
import { formatDateTime } from "../../../lib/format";
import { setKnowledgeStatus } from "./actions";

export interface KnowledgeRowData {
  id: string;
  kind: string;
  content: string;
  note: string | null;
  source: string;
  status: string;
  skuCode: string | null;
  createdAt: string;
}

const KIND_LABEL: Record<string, string> = {
  COMPATIBILIDADE: "Compatibilidade",
  ESPECIFICACAO: "Especificação",
  POLITICA: "Política",
  OUTRO: "Outro",
};

const STATUS_LABEL: Record<string, string> = {
  SUGERIDO: "Sugerido",
  VALIDADO: "Validado",
  REJEITADO: "Rejeitado",
  OBSOLETO: "Obsoleto",
};

const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
  verticalAlign: "top",
};

export function KnowledgeRow({
  entry,
  canManage,
}: {
  entry: KnowledgeRowData;
  canManage: boolean;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function change(status: "VALIDADO" | "REJEITADO" | "OBSOLETO"): void {
    setBusy(true);
    setError(null);

    void setKnowledgeStatus(entry.id, status).then((result) => {
      setBusy(false);

      if (!result.ok) {
        setError(result.message);
      }
    });
  }

  const actionButton = (label: string, status: "VALIDADO" | "REJEITADO" | "OBSOLETO"): ReactNode => (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        change(status);
      }}
      style={{
        border: "1px solid var(--sb-border)",
        borderRadius: "var(--sb-radius)",
        background: "var(--sb-surface)",
        padding: "0.25rem 0.5rem",
        fontSize: "0.75rem",
        cursor: busy ? "default" : "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <tr>
      <td style={td}>{entry.skuCode ?? "geral"}</td>
      <td style={td}>{KIND_LABEL[entry.kind] ?? entry.kind}</td>
      <td style={{ ...td, whiteSpace: "pre-wrap", maxWidth: "26rem" }}>
        {entry.content}
        {entry.note !== null && (
          <span style={{ display: "block", color: "var(--sb-text-soft)", fontSize: "0.8125rem" }}>{entry.note}</span>
        )}
      </td>
      <td style={td}>{entry.source}</td>
      <td style={{ ...td, whiteSpace: "nowrap" }}>{formatDateTime(entry.createdAt)}</td>
      <td style={td}>
        <StatusPill code={entry.status} label={STATUS_LABEL[entry.status] ?? entry.status} />

        {canManage && (
          <div style={{ display: "flex", gap: "0.375rem", marginTop: "0.375rem", flexWrap: "wrap" }}>
            {entry.status !== "VALIDADO" && actionButton(busy ? "…" : "Validar", "VALIDADO")}
            {entry.status === "SUGERIDO" && actionButton("Rejeitar", "REJEITADO")}
            {entry.status === "VALIDADO" && actionButton("Tornar obsoleto", "OBSOLETO")}
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
