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
  // Apagar não tem volta: pede um segundo clique, na própria linha (lote 2 do
  // pente fino, 18/09 — antes o primeiro clique já apagava).
  const [confirmando, setConfirmando] = useState(false);

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
    <li className="sb-template-row">
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
          <div className="sb-template-actions">
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
          <strong className="sb-template-name">{template.name}</strong>
          <p className="sb-template-body">{template.body}</p>
          {canManage && !confirmando && (
            <div className="sb-template-actions">
              <button className="sb-button" type="button" disabled={busy} onClick={() => { setEditing(true); }}>
                Editar
              </button>
              <button className="sb-button sb-template-danger" type="button" disabled={busy} onClick={() => { setConfirmando(true); }}>
                Apagar
              </button>
            </div>
          )}
          {canManage && confirmando && (
            <div className="sb-template-confirm" role="group" aria-label="Confirmar exclusão">
              <span>Apagar “{template.name}”? Não dá para desfazer.</span>
              <button
                className="sb-button sb-template-danger"
                type="button"
                disabled={busy}
                onClick={() => void run(() => deleteTemplate(template.id))}
              >
                {busy ? "Apagando…" : "Sim, apagar"}
              </button>
              <button className="sb-button" type="button" disabled={busy} onClick={() => { setConfirmando(false); }}>
                Cancelar
              </button>
            </div>
          )}
        </>
      )}

      {error !== null && (
        <p role="alert" className="sb-template-error">
          {error}
        </p>
      )}
    </li>
  );
}
