"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { eventTypeLabel, severityLabel } from "../../../lib/labels";
import { createPreference } from "./actions";

const SEVERITY_OPTIONS = ["informativo", "importante", "critico"];

const ALL_TYPES = "";
const ALL_ACCOUNTS = "";

export function NewPreferenceForm({
  eventTypes,
  accounts,
}: {
  eventTypes: string[];
  accounts: { id: string; label: string }[];
}): ReactNode {
  const router = useRouter();
  const [eventType, setEventType] = useState(ALL_TYPES);
  const [accountId, setAccountId] = useState(ALL_ACCOUNTS);
  const [minSeverity, setMinSeverity] = useState("informativo");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(): Promise<void> {
    setBusy(true);
    setError(null);
    setSuccess(null);

    const result = await createPreference({
      eventType: eventType === ALL_TYPES ? null : eventType,
      mlAccountId: accountId === ALL_ACCOUNTS ? null : accountId,
      minSeverity,
      enabled,
    });

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    setEventType(ALL_TYPES);
    setAccountId(ALL_ACCOUNTS);
    setMinSeverity("informativo");
    setEnabled(true);
    setSuccess("Preferência adicionada.");
    router.refresh();
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
      className="sb-notification-preference-form"
    >
      <div className="sb-notification-preference-form-heading">
        <strong>Nova regra</strong>
        <span>Combine tipo e conta; deixe ambos em “Todos” para criar a regra geral.</span>
      </div>

      <label className="sb-notification-preference-field">
        Tipo de evento
        <select
          className="sb-input"
          value={eventType}
          onChange={(event) => {
            setEventType(event.target.value);
          }}
        >
          <option value={ALL_TYPES}>Todos os tipos</option>
          {eventTypes.map((type) => (
            <option key={type} value={type}>
              {eventTypeLabel(type)}
            </option>
          ))}
        </select>
      </label>

      <label className="sb-notification-preference-field">
        Conta
        <select
          className="sb-input"
          value={accountId}
          onChange={(event) => {
            setAccountId(event.target.value);
          }}
        >
          <option value={ALL_ACCOUNTS}>Todas as contas</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.label}
            </option>
          ))}
        </select>
      </label>

      <label className="sb-notification-preference-field">
        Severidade mínima
        <select
          className="sb-input"
          value={minSeverity}
          onChange={(event) => {
            setMinSeverity(event.target.value);
          }}
        >
          {SEVERITY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {severityLabel(option)}
            </option>
          ))}
        </select>
      </label>

      <label className="sb-notification-preference-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
          }}
        />
        Ativa
      </label>

      <button
        className="sb-button sb-button-primary"
        type="submit"
        disabled={busy}
      >
        Adicionar preferência
      </button>

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
    </form>
  );
}
