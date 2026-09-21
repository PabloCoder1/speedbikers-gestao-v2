"use client";

import { useState, type ReactNode } from "react";

import { eventTypeLabel, severityLabel } from "../../../lib/labels";
import { deletePreference, updatePreference } from "./actions";

/**
 * Uma preferência configurada (Fase 7, item 6, D-076) — mesmo padrão de
 * `apps/web/app/acoes/action-card.tsx`: componente cliente por linha (estado
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



export function PreferenceRow({ preference }: { preference: PreferenceRowData }): ReactNode {
  const [minSeverity, setMinSeverity] = useState(preference.minSeverity);
  const [enabled, setEnabled] = useState(preference.enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const eventLabel = preference.eventType === null ? "Todos os tipos" : eventTypeLabel(preference.eventType);
  const accountLabel = preference.accountLabel ?? "Todas as contas";
  const scopeLabel = `${eventLabel}, ${accountLabel}`;

  async function save(next: { minSeverity: string; enabled: boolean }): Promise<void> {
    setBusy(true);
    setError(null);
    setSuccess(null);

    const result = await updatePreference(preference.id, next);

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    setMinSeverity(next.minSeverity);
    setEnabled(next.enabled);
    setSuccess("Preferência atualizada.");
  }

  async function handleDelete(): Promise<void> {
    setBusy(true);
    setError(null);
    setSuccess(null);

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
      <td data-label="Tipo de evento">{eventLabel}</td>
      <td data-label="Conta">{accountLabel}</td>
      <td data-label="Severidade mínima">
        <select
          className="sb-input"
          aria-label={`Severidade mínima para ${scopeLabel}`}
          value={minSeverity}
          disabled={busy}
          onChange={(event) => {
            void save({ minSeverity: event.target.value, enabled });
          }} style={{ color: "inherit" }}
        >
          {SEVERITY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {severityLabel(option)}
            </option>
          ))}
        </select>
      </td>
      <td data-label="Estado">
        <label style={{ display: "flex", alignItems: "center", gap: "0.375rem", fontSize: "0.8125rem", cursor: "pointer" }}>
          <input
            type="checkbox"
            aria-label={`Preferência ativa para ${scopeLabel}`}
            checked={enabled}
            disabled={busy}
            onChange={(event) => {
              void save({ minSeverity, enabled: event.target.checked });
            }}
          />
          {enabled ? "Ativa" : "Desativada"}
        </label>
      </td>
      <td data-label="Ações" className="sb-notification-preference-actions">
        {!confirmingRemoval ? (
          <button
            className="sb-button"
            type="button"
            disabled={busy}
            aria-label={`Remover preferência: ${scopeLabel}`}
            onClick={() => {
              setConfirmingRemoval(true);
              setError(null);
              setSuccess(null);
            }}
          >
            Remover
          </button>
        ) : (
          <div className="sb-notification-preference-remove" role="group" aria-label={`Confirmar remoção: ${scopeLabel}`}>
            <span>Remover esta regra?</span>
            <button
              className="sb-button sb-button-danger"
              type="button"
              disabled={busy}
              onClick={() => {
                void handleDelete();
              }}
            >
              {busy ? "Removendo…" : "Remover"}
            </button>
            <button
              className="sb-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmingRemoval(false);
              }}
            >
              Cancelar
            </button>
          </div>
        )}

        {error !== null && (
          <p className="sb-notification-preference-feedback is-error" role="alert">
            {error}
          </p>
        )}
        {success !== null && (
          <p className="sb-notification-preference-feedback is-success" role="status">
            {success}
          </p>
        )}
      </td>
    </tr>
  );
}
