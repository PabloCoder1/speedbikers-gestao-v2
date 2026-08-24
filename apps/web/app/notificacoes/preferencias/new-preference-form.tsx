"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { eventTypeLabel, severityLabel } from "../../../lib/labels";
import { createPreference } from "./actions";

const SEVERITY_OPTIONS = ["informativo", "importante", "critico"];

const ALL_TYPES = "";
const ALL_ACCOUNTS = "";

const fieldStyle: React.CSSProperties = {
  padding: "0.375rem 0.625rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  background: "transparent",
  color: "inherit",
  fontSize: "0.8125rem",
};

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

  async function handleSubmit(): Promise<void> {
    setBusy(true);
    setError(null);

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
    router.refresh();
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
      style={{
        display: "flex",
        gap: "var(--sb-space-2)",
        alignItems: "flex-end",
        flexWrap: "wrap",
        border: "1px solid var(--sb-border)",
        borderRadius: "var(--sb-radius)",
        padding: "var(--sb-space-3)",
      }}
    >
      <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.75rem" }}>
        Tipo de evento
        <select
          value={eventType}
          onChange={(event) => {
            setEventType(event.target.value);
          }}
          style={fieldStyle}
        >
          <option value={ALL_TYPES}>Todos os tipos</option>
          {eventTypes.map((type) => (
            <option key={type} value={type}>
              {eventTypeLabel(type)}
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.75rem" }}>
        Conta
        <select
          value={accountId}
          onChange={(event) => {
            setAccountId(event.target.value);
          }}
          style={fieldStyle}
        >
          <option value={ALL_ACCOUNTS}>Todas as contas</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.label}
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.75rem" }}>
        Severidade mínima
        <select
          value={minSeverity}
          onChange={(event) => {
            setMinSeverity(event.target.value);
          }}
          style={fieldStyle}
        >
          {SEVERITY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {severityLabel(option)}
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: "0.375rem", fontSize: "0.8125rem", paddingBottom: "0.375rem" }}>
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
        type="submit"
        disabled={busy}
        style={{
          padding: "0.375rem 0.875rem",
          borderRadius: "var(--sb-radius)",
          border: "1px solid var(--sb-primary)",
          background: "var(--sb-primary)",
          color: "#fff",
          fontSize: "0.8125rem",
          cursor: "pointer",
        }}
      >
        Adicionar preferência
      </button>

      {error !== null && (
        <p role="alert" style={{ margin: 0, width: "100%", fontSize: "0.75rem", color: "var(--sb-danger)" }}>
          {error}
        </p>
      )}
    </form>
  );
}
