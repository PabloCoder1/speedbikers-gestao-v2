"use client";

import { useState, type ReactNode } from "react";

import type { TemplateActionResult } from "./actions";
import { deleteTemplate, updateTemplate } from "./actions";

/**
 * Linha editável de template (D-111). Edição inline, mesmo espírito das
 * preferências de notificação (D-076): sem modal, salvar e apagar por linha.
 */

export interface TemplateRowData {
  id: string;
  name: string;
  body: string;
}

export function TemplateRow({ template, canManage }: { template: TemplateRowData; canManage: boolean }): ReactNode {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(template.name);
  const [body, setBody] = useState(template.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<TemplateActionResult>): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await action();

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    setEditing(false);
  }

  return (
    <li
      style={{
        border: "1px solid var(--sb-border)",
        borderRadius: "var(--sb-radius)",
        padding: "var(--sb-space-3)",
        display: "grid",
        gap: "var(--sb-space-2)",
        background: "var(--sb-surface)",
      }}
    >
      {editing ? (
        <>
          <input className="sb-input" aria-label="Nome do template" value={name} maxLength={80} onChange={(event) => { setName(event.target.value); }} />
          <textarea
            className="sb-input"
            aria-label="Texto do template"
            value={body}
            rows={4}
            maxLength={2000}
            onChange={(event) => { setBody(event.target.value); }}
          />
          <div style={{ display: "flex", gap: "var(--sb-space-2)" }}>
            <button className="sb-button" type="button" disabled={busy} onClick={() => void run(() => updateTemplate(template.id, name, body))}>
              {busy ? "Salvando…" : "Salvar"}
            </button>
            <button
              className="sb-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setName(template.name);
                setBody(template.body);
                setError(null);
                setEditing(false);
              }}
            >
              Cancelar
            </button>
          </div>
        </>
      ) : (
        <>
          <strong style={{ fontSize: "0.9375rem" }}>{template.name}</strong>
          <p style={{ margin: 0, fontSize: "0.875rem", whiteSpace: "pre-wrap", color: "var(--sb-text-soft)" }}>
            {template.body}
          </p>
          {canManage && (
            <div style={{ display: "flex", gap: "var(--sb-space-2)" }}>
              <button className="sb-button" type="button" disabled={busy} onClick={() => { setEditing(true); }}>
                Editar
              </button>
              <button className="sb-button" type="button" disabled={busy} onClick={() => void run(() => deleteTemplate(template.id))}>
                {busy ? "…" : "Apagar"}
              </button>
            </div>
          )}
        </>
      )}

      {error !== null && (
        <p role="alert" style={{ margin: 0, color: "var(--sb-danger)", fontSize: "0.8125rem" }}>
          {error}
        </p>
      )}
    </li>
  );
}
