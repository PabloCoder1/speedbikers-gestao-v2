"use client";

import { useState, type ReactNode } from "react";

import { useDialogo } from "../../../components/use-dialogo";
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
  const [removed, setRemoved] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  // Remover é destrutivo: foco vai para o Cancelar, e Esc some enquanto a
  // remoção está em voo — mesmo comportamento de `remover-vinculo.tsx`.
  const dialogo = useDialogo<HTMLDivElement>(
    confirmando,
    () => {
      setConfirmando(false);
    },
    !busy,
  );

  const label = preference.eventType === null ? "todos os tipos de evento" : eventTypeLabel(preference.eventType);
  const account = preference.accountLabel ?? "todas as contas";

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

    setConfirmando(false);
    setRemoved(true);
  }

  if (removed) return null;

  return (
    <tr>
      <td>{preference.eventType === null ? "Todos os tipos" : eventTypeLabel(preference.eventType)}</td>
      <td>{preference.accountLabel ?? "Todas as contas"}</td>
      <td>
        <select
          className="sb-input"
          aria-label={`Severidade mínima — ${label}, ${account}`}
          value={minSeverity}
          disabled={busy}
          onChange={(event) => {
            void save({ minSeverity: event.target.value, enabled });
          }}
          style={{ color: "inherit" }}
        >
          {SEVERITY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {severityLabel(option)}
            </option>
          ))}
        </select>
      </td>
      <td>
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
      <td>
        <button
          className="sb-text-button"
          type="button"
          disabled={busy}
          onClick={() => {
            setError(null);
            setConfirmando(true);
          }}
        >
          Remover
        </button>

        {error !== null && !confirmando && (
          <p role="alert" style={{ margin: "0.25rem 0 0", fontSize: "0.75rem", color: "var(--sb-danger)" }}>
            {error}
          </p>
        )}

        {confirmando && (
          <div
            className="sb-backdrop"
            onClick={() => {
              if (!busy) setConfirmando(false);
            }}
          >
            <div
              ref={dialogo}
              role="dialog"
              aria-modal="true"
              aria-label="Remover regra de notificação"
              className="sb-modal"
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <span className="sb-modal-eyebrow">Remover regra</span>
              <h2 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1rem" }}>Remover esta regra?</h2>

              <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem" }}>
                A regra para <strong>{label}</strong> em <strong>{account}</strong> deixa de existir. Sem ela, esse
                evento volta a virar toast pela regra mais próxima — ou por padrão, se não houver outra.
              </p>

              {error !== null && (
                <p style={{ margin: "0 0 var(--sb-space-3)", color: "var(--sb-danger)", fontSize: "0.75rem" }}>{error}</p>
              )}

              <div style={{ display: "flex", gap: "var(--sb-space-2)", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="sb-button"
                  disabled={busy}
                  data-foco-inicial
                  onClick={() => {
                    setConfirmando(false);
                  }}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="sb-button sb-button-danger"
                  disabled={busy}
                  onClick={() => {
                    void handleDelete();
                  }}
                >
                  {busy ? "Removendo…" : "Remover regra"}
                </button>
              </div>
            </div>
          </div>
        )}
      </td>
    </tr>
  );
}
