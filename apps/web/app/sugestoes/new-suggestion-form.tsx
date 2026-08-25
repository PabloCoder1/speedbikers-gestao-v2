"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { createSuggestion } from "./actions";

const textareaStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.75rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
  fontFamily: "inherit",
  resize: "vertical",
  color: "inherit",
  background: "transparent",
};

export function NewSuggestionForm(): ReactNode {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handleSubmit(): Promise<void> {
    setBusy(true);
    setError(null);
    setSent(false);

    const result = await createSuggestion(text);

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    setText("");
    setSent(true);
    router.refresh();
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
      style={{
        display: "grid",
        gap: "var(--sb-space-2)",
        border: "1px solid var(--sb-border)",
        borderRadius: "var(--sb-radius)",
        padding: "var(--sb-space-3)",
        marginBottom: "var(--sb-space-4)",
      }}
    >
      <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
        Sugerir uma melhoria
        <textarea
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
          rows={4}
          maxLength={5000}
          placeholder="Descreva o problema ou a ideia com suas próprias palavras — o texto é preservado exatamente como você escreveu."
          style={{ ...textareaStyle, marginTop: "0.375rem" }}
        />
      </label>

      <div style={{ display: "flex", alignItems: "center", gap: "var(--sb-space-2)" }}>
        <button
          type="submit"
          disabled={busy || text.trim().length === 0}
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
          {busy ? "Enviando…" : "Enviar sugestão"}
        </button>

        {sent && <span style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>Enviada.</span>}
      </div>

      {error !== null && (
        <p role="alert" style={{ margin: 0, fontSize: "0.8125rem", color: "var(--sb-danger)" }}>
          {error}
        </p>
      )}
    </form>
  );
}
