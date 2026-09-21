"use client";

import type { EventSeverity } from "@sb/domain";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { eventTypeLabel, severityLabel } from "../../../lib/labels";
import { createPreference } from "./actions";

const SEVERITY_OPTIONS = ["informativo", "importante", "critico"];

const ALL_TYPES = "";
const ALL_ACCOUNTS = "";

/**
 * Agrupa o catálogo por domínio (`listing`, `stock`, `order`…) só para o
 * `<optgroup>` — o mesmo catálogo achatado do `page.tsx` fica difícil de
 * escanear com 23 linhas soltas. Rótulo que o prefixo não prevê cai em
 * "Outros" em vez de sumir, mesmo raciocínio de degradar sem quebrar de
 * `lib/labels.ts`.
 */
const CATEGORY_LABEL: Record<string, string> = {
  listing: "Anúncio",
  stock: "Estoque",
  order: "Pedido",
  sync: "Sincronização",
  ai: "Inteligência artificial",
  support: "Atendimento",
};

function categoryOf(eventType: string): string {
  return CATEGORY_LABEL[eventType.split(".")[0] ?? ""] ?? "Outros";
}

export function NewPreferenceForm({
  eventTypes,
  eventSeverity,
  accounts,
}: {
  eventTypes: string[];
  eventSeverity: Readonly<Record<string, EventSeverity>>;
  accounts: { id: string; label: string }[];
}): ReactNode {
  const router = useRouter();
  const [eventType, setEventType] = useState(ALL_TYPES);
  const [accountId, setAccountId] = useState(ALL_ACCOUNTS);
  const [minSeverity, setMinSeverity] = useState("informativo");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const byCategory = new Map<string, string[]>();

    for (const type of eventTypes) {
      const category = categoryOf(type);

      byCategory.set(category, [...(byCategory.get(category) ?? []), type]);
    }

    return [...byCategory.entries()];
  }, [eventTypes]);

  const defaultSeverity = eventType === ALL_TYPES ? null : (eventSeverity[eventType] ?? null);

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
      }}
    >
      <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.75rem" }}>
        Tipo de evento
        <select
          className="sb-input"
          value={eventType}
          onChange={(event) => {
            setEventType(event.target.value);
          }}
        >
          <option value={ALL_TYPES}>Todos os tipos</option>
          {groups.map(([category, types]) => (
            <optgroup key={category} label={category}>
              {types.map((type) => (
                <option key={type} value={type}>
                  {eventTypeLabel(type)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.75rem" }}>
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

      <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.75rem" }}>
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
        {defaultSeverity !== null && (
          <small style={{ color: "var(--sb-text-soft)", fontWeight: 400 }}>
            Padrão deste evento: {severityLabel(defaultSeverity)}
          </small>
        )}
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

      <button className="sb-button sb-button-primary" type="submit" disabled={busy}>
        {busy ? "Adicionando…" : "Adicionar preferência"}
      </button>

      {error !== null && (
        <p role="alert" style={{ margin: 0, width: "100%", fontSize: "0.75rem", color: "var(--sb-danger)" }}>
          {error}
        </p>
      )}
    </form>
  );
}
