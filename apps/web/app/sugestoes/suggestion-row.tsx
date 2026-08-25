"use client";

import { useState, type ReactNode } from "react";

import { StatusPill } from "../../components/status-pill";
import { formatDateTime } from "../../lib/format";
import { featureSuggestionStatusLabel } from "../../lib/labels";
import { SUGGESTION_STATUS_VALUES, updateSuggestionStatus, type SuggestionStatus } from "./actions";

/**
 * Uma sugestão na Central (Fase 7, item 9, D-079) — mesmo padrão de
 * `apps/web/app/acoes/action-row.tsx`: componente cliente por linha
 * (estado local de ocupado/erro), Server Action por clique, sem RPC.
 */

export interface SuggestionRowData {
  id: string;
  originalText: string;
  status: string;
  createdAt: string;
  authorName: string | null;
}

const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
  verticalAlign: "top",
};

export function SuggestionRow({
  suggestion,
  canManage,
}: {
  suggestion: SuggestionRowData;
  canManage: boolean;
}): ReactNode {
  const [status, setStatus] = useState(suggestion.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStatusChange(next: SuggestionStatus): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await updateSuggestionStatus(suggestion.id, next);

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    setStatus(next);
  }

  return (
    <tr>
      <td style={{ ...td, whiteSpace: "pre-wrap", maxWidth: "28rem" }}>{suggestion.originalText}</td>
      <td style={td}>{suggestion.authorName ?? "—"}</td>
      <td style={{ ...td, whiteSpace: "nowrap" }}>{formatDateTime(suggestion.createdAt)}</td>
      <td style={td}>
        {canManage ? (
          <select
            value={status}
            disabled={busy}
            onChange={(event) => {
              void handleStatusChange(event.target.value as SuggestionStatus);
            }}
            style={{
              padding: "0.25rem 0.5rem",
              borderRadius: "var(--sb-radius)",
              border: "1px solid var(--sb-border)",
              background: "transparent",
              color: "inherit",
              fontSize: "0.8125rem",
            }}
          >
            {SUGGESTION_STATUS_VALUES.map((option) => (
              <option key={option} value={option}>
                {featureSuggestionStatusLabel(option)}
              </option>
            ))}
          </select>
        ) : (
          <StatusPill code={status} label={featureSuggestionStatusLabel(status)} />
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
