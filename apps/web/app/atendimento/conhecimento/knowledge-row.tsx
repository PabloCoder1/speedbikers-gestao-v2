"use client";

import { useState, type ReactNode } from "react";

import { StatusPill } from "../../../components/status-pill";
import { formatDateTime } from "../../../lib/format";
import { setKnowledgeStatus } from "./actions";
import {
  KNOWLEDGE_KIND_LABEL,
  KNOWLEDGE_SOURCE_LABEL,
  KNOWLEDGE_STATUS_LABEL,
} from "./constants";

export interface KnowledgeRowData {
  id: string;
  kind: string;
  content: string;
  note: string | null;
  source: string;
  status: string;
  skuCode: string | null;
  /** Quem confirmou — só existe em VALIDADO, por constraint do banco. */
  confirmedByName: string | null;
  updatedAt: string;
}

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
      {/* "geral" e não "—": conhecimento sem SKU vale para o catálogo inteiro,
          o que é uma afirmação, não uma ausência. */}
      <td className="sb-mono">{entry.skuCode ?? "geral"}</td>

      <td>{KNOWLEDGE_KIND_LABEL[entry.kind] ?? entry.kind}</td>

      <td style={{ whiteSpace: "pre-wrap", maxWidth: "26rem" }}>
        {entry.content}
        {entry.note !== null && (
          <span style={{ display: "block", color: "var(--sb-text-soft)", fontSize: "0.625rem" }}>{entry.note}</span>
        )}
      </td>

      <td>{KNOWLEDGE_SOURCE_LABEL[entry.source] ?? entry.source}</td>

      {/*
        "Confirmado por" do frame. Só VALIDADO tem — a constraint
        `knowledge_entries_validation_coherent` exige quem e quando, porque
        "confirmação anônima seria o oposto do propósito da tabela". O "—" aqui
        é a ausência CORRETA, não um dado que faltou carregar.
      */}
      <td>
        {entry.confirmedByName ?? <span style={{ color: "var(--sb-text-soft)" }}>—</span>}
      </td>

      <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(entry.updatedAt)}</td>

      <td>
        <StatusPill code={entry.status} label={KNOWLEDGE_STATUS_LABEL[entry.status] ?? entry.status} />

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
