"use client";

import { useState, type ReactNode } from "react";

import { eventTypeLabel, severityLabel } from "../../../lib/labels";
import { deletePreference, updatePreference } from "./actions";

/**
 * Uma preferência configurada (Fase 7, item 6, D-076) — mesmo padrão de
 * `apps/web/app/acoes/action-row.tsx`: componente cliente por linha (estado
 * local de ocupado/erro), Server Action por clique, sem RPC.
 *
 * `eventType`/`accountId` são fixos depois de criada — mudar QUAL evento a
 * regra alcança é criar outra (a identidade da regra), só `minSeverity`/
 * `enabled` (a política) são editáveis aqui.
 */

export interface PreferenceRowData {
  id: string;
  eventType: string | null;
  accountLabel: string | null;
  minSeverity: string;
  enabled: boolean;
}

const SEVERITY_OPTIONS = ["informativo", "importante", "critico"];

const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
  verticalAlign: "middle",
};

export function PreferenceRow({ preference }: { preference: PreferenceRowData }): ReactNode {
  const [minSeverity, setMinSeverity] = useState(preference.minSeverity);
  const [enabled, setEnabled] = useState(preference.enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);

  async function save(next: { minSeverity: string; enabled: boolean }): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await updatePreference(preference.id, next);

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    setMinSeverity(next.minSeverity);
    setEnabled(next.enabled);
  }

  async function handleDelete(): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await deletePreference(preference.id);

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    setRemoved(true);
  }

  if (removed) return null;

  return (
    <tr>
      <td style={td}>{preference.eventType === null ? "Todos os tipos" : eventTypeLabel(preference.eventType)}</td>
      <td style={td}>{preference.accountLabel ?? "Todas as contas"}</td>
      <td style={td}>
        <select
          value={minSeverity}
          disabled={busy}
          onChange={(event) => {
            void save({ minSeverity: event.target.value, enabled });
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
          {SEVERITY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {severityLabel(option)}
            </option>
          ))}
        </select>
      </td>
      <td style={td}>
        <label style={{ display: "flex", alignItems: "center", gap: "0.375rem", fontSize: "0.8125rem", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(event) => {
              void save({ minSeverity, enabled: event.target.checked });
            }}
          />
          {enabled ? "Ativa" : "Desativada"}
        </label>
      </td>
      <td style={td}>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void handleDelete();
          }}
          style={{
            padding: "0.25rem 0.625rem",
            borderRadius: "var(--sb-radius)",
            border: "1px solid var(--sb-border)",
            background: "transparent",
            fontSize: "0.75rem",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          Remover
        </button>

        {error !== null && (
          <p role="alert" style={{ margin: "0.25rem 0 0", fontSize: "0.75rem", color: "var(--sb-danger)" }}>
            {error}
          </p>
        )}
      </td>
    </tr>
  );
}
