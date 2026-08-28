"use client";

import { useState, type ReactNode } from "react";

import { createTemplate } from "./actions";

/** Criação de template (D-111) — só renderizado para ADMIN/GESTOR. */
export function NewTemplateForm(): ReactNode {
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const input = {
    width: "100%",
    padding: "0.5rem 0.625rem",
    border: "1px solid var(--sb-border)",
    borderRadius: "var(--sb-radius)",
    fontSize: "0.875rem",
    fontFamily: "inherit",
  } as const;

  return (
    <div style={{ display: "grid", gap: "var(--sb-space-2)", maxWidth: "40rem" }}>
      <label htmlFor="novo-nome" style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Nome
      </label>
      <input id="novo-nome" value={name} maxLength={80} style={input} onChange={(event) => { setName(event.target.value); }} />

      <label htmlFor="novo-texto" style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Texto
      </label>
      <textarea
        id="novo-texto"
        value={body}
        rows={4}
        maxLength={2000}
        style={{ ...input, resize: "vertical" }}
        onChange={(event) => { setBody(event.target.value); }}
      />

      <div>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void createTemplate(name, body).then((result) => {
              setBusy(false);

              if (!result.ok) {
                setError(result.message);

                return;
              }

              setName("");
              setBody("");
            });
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
