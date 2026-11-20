"use client";

import { useState, type ReactNode } from "react";

import { createTemplate } from "./actions";

/** Criação de template (D-111) — só renderizado para ADMIN/GESTOR. */
export function NewTemplateForm(): ReactNode {
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const result = await createTemplate(name, body);

      if (!result.ok) {
        setError(result.message ?? "Não foi possível criar o template.");

        return;
      }

      setName("");
      setBody("");
    } catch {
      setError("Não foi possível confirmar a criação. Confira a lista antes de tentar novamente.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: "var(--sb-space-2)", maxWidth: "40rem" }}>
      <label htmlFor="novo-nome" style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Nome
      </label>
      <input className="sb-input" id="novo-nome" value={name} maxLength={80} onChange={(event) => { setName(event.target.value); }} />

      <label htmlFor="novo-texto" style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Texto
      </label>
      <textarea
        className="sb-input"
        id="novo-texto"
        value={body}
        rows={4}
        maxLength={2000}
        onChange={(event) => { setBody(event.target.value); }}
      />

      <div>
        <button
          className="sb-button sb-button-primary"
          type="button"
          disabled={busy}
          onClick={() => {
            void submit();
          }}
        >
          {busy ? "Criando…" : "Criar template"}
        </button>
      </div>

      {error !== null && (
        <p role="alert" style={{ margin: 0, color: "var(--sb-danger)", fontSize: "0.8125rem" }}>
          {error}
        </p>
      )}
    </div>
  );
}
