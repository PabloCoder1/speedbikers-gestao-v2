"use client";

import { useState, type ReactNode } from "react";

import type { KnowledgeKind, KnowledgeSource } from "./actions";
import { KNOWLEDGE_KINDS, KNOWLEDGE_SOURCES, createKnowledgeEntry } from "./actions";

/**
 * Registro de conhecimento (D-113) — qualquer membro sugere; nasce SUGERIDO
 * (a policy força, não a UI) e só vira evidência do Copiloto depois de um
 * ADMIN/GESTOR validar.
 */
export function NewKnowledgeForm(): ReactNode {
  const [kind, setKind] = useState<KnowledgeKind>("COMPATIBILIDADE");
  const [source, setSource] = useState<KnowledgeSource>("CONFIRMACAO_INTERNA");
  const [skuCode, setSkuCode] = useState("");
  const [content, setContent] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const input = {
    padding: "0.5rem 0.625rem",
    border: "1px solid var(--sb-border)",
    borderRadius: "var(--sb-radius)",
    fontSize: "0.875rem",
    fontFamily: "inherit",
  } as const;

  return (
    <div style={{ display: "grid", gap: "var(--sb-space-2)", maxWidth: "40rem" }}>
      <div style={{ display: "flex", gap: "var(--sb-space-2)", flexWrap: "wrap" }}>
        <label style={{ fontSize: "0.8125rem", display: "grid", gap: "0.25rem" }}>
          Tipo
          <select value={kind} style={input} onChange={(event) => { setKind(event.target.value as KnowledgeKind); }}>
            {KNOWLEDGE_KINDS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label style={{ fontSize: "0.8125rem", display: "grid", gap: "0.25rem" }}>
          Fonte
          <select value={source} style={input} onChange={(event) => { setSource(event.target.value as KnowledgeSource); }}>
            {KNOWLEDGE_SOURCES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label style={{ fontSize: "0.8125rem", display: "grid", gap: "0.25rem" }}>
          SKU (vazio = geral)
          <input value={skuCode} style={input} onChange={(event) => { setSkuCode(event.target.value); }} />
        </label>
      </div>

      <label htmlFor="fato" style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Fato (ex.: “Compatível com Honda X-ADV 750 2022-2025”)
      </label>
      <textarea
        id="fato"
        value={content}
        rows={2}
        maxLength={500}
        style={{ ...input, resize: "vertical" }}
        onChange={(event) => { setContent(event.target.value); }}
      />

      <label htmlFor="obs" style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Observação (opcional)
      </label>
      <input id="obs" value={note} maxLength={1000} style={input} onChange={(event) => { setNote(event.target.value); }} />

      <div>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setFeedback(null);
            void createKnowledgeEntry({ kind, source, content, note, skuCode }).then((result) => {
              setBusy(false);

              if (!result.ok) {
                setFeedback({ ok: false, text: result.message ?? "Não foi possível registrar." });

                return;
              }

              setContent("");
              setNote("");
              setSkuCode("");
              setFeedback({ ok: true, text: "Registrado como SUGERIDO — aguarda validação." });
            });
          }}
        >
          {busy ? "Registrando…" : "Registrar conhecimento"}
        </button>
      </div>

      {feedback !== null && (
        <p
          role={feedback.ok ? undefined : "alert"}
          style={{ margin: 0, fontSize: "0.8125rem", color: feedback.ok ? "var(--sb-text-soft)" : "var(--sb-danger)" }}
        >
          {feedback.text}
        </p>
      )}
    </div>
  );
}
