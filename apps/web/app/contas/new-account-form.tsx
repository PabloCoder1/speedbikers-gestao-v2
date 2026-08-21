"use client";

import { useState, type ReactNode } from "react";

import { createMlAccount } from "./actions";

/**
 * Formulário de cadastro de conta Mercado Livre.
 *
 * Só cria a linha (`ml_accounts`, `status = 'PENDING'`) — conectar de
 * verdade é uma ação separada (`connect-button.tsx`), porque exige o
 * `client_secret` que só a `api` conhece.
 */

const inputStyle: React.CSSProperties = {
  padding: "0.5rem 0.625rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
};

export function NewAccountForm(): ReactNode {
  const [label, setLabel] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await createMlAccount(label, slug);

    if (!result.ok) {
      setError(result.message);
      setBusy(false);

      return;
    }

    setLabel("");
    setSlug("");
    setBusy(false);
  }

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-end",
        gap: "var(--sb-space-2)",
        padding: "var(--sb-space-3)",
        border: "1px solid var(--sb-border)",
        borderRadius: "var(--sb-radius)",
        marginBottom: "var(--sb-space-4)",
      }}
    >
      <label style={{ display: "grid", gap: "0.25rem", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Rótulo
        <input
          type="text"
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
          }}
          placeholder="Speedbikers (loja 1)"
          disabled={busy}
          style={{ ...inputStyle, width: "16rem" }}
        />
      </label>

      <label style={{ display: "grid", gap: "0.25rem", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Identificador (nomeia a fila interna)
        <input
          type="text"
          value={slug}
          onChange={(event) => {
            setSlug(event.target.value.toLowerCase());
          }}
          placeholder="speedbikers-loja-1"
          disabled={busy}
          style={{ ...inputStyle, width: "14rem", fontFamily: "ui-monospace, monospace" }}
        />
      </label>

      <button
        type="button"
        onClick={() => {
          void submit();
        }}
        disabled={busy || label.trim() === "" || slug.trim() === ""}
        style={{
          padding: "0.5rem 1rem",
          borderRadius: "var(--sb-radius)",
          border: "none",
          background: "var(--sb-primary)",
          color: "var(--sb-white)",
          fontWeight: 600,
          fontSize: "0.875rem",
          cursor: busy ? "not-allowed" : "pointer",
          opacity: busy || label.trim() === "" || slug.trim() === "" ? 0.5 : 1,
        }}
      >
        Cadastrar conta
      </button>

      {error !== null && (
        <p role="alert" style={{ margin: 0, width: "100%", fontSize: "0.8125rem", color: "var(--sb-danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
