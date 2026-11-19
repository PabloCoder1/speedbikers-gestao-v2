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


export function NewAccountForm(): ReactNode {
  const [label, setLabel] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    let result: Awaited<ReturnType<typeof createMlAccount>>;
    try {
      result = await createMlAccount(label, slug);
    } catch {
      setError("Não foi possível confirmar o cadastro. Confira a lista antes de tentar novamente.");
      return;
    } finally {
      setBusy(false);
    }

    if (!result.ok) {
      setError(result.message);

      return;
    }

    setLabel("");
    setSlug("");
  }

  return (
    <div className="sb-account-form">
      <label className="sb-account-form-field">
        Rótulo
        <input
          className="sb-input"
          type="text"
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
          }}
          placeholder="Speedbikers (loja 1)"
          disabled={busy}
        />
      </label>

      <label className="sb-account-form-field">
        Identificador (nomeia a fila interna)
        <input
          className="sb-input sb-mono"
          type="text"
          value={slug}
          onChange={(event) => {
            setSlug(event.target.value.toLowerCase());
          }}
          placeholder="speedbikers-loja-1"
          disabled={busy}
        />
      </label>

      <button
        className="sb-button sb-button-primary"
        type="button"
        onClick={() => {
          void submit();
        }}
        disabled={busy || label.trim() === "" || slug.trim() === ""}
      >
        {busy ? "Cadastrando…" : "Cadastrar conta"}
      </button>

      {error !== null && (
        <p role="alert" className="sb-account-form-error">
          {error}
        </p>
      )}
    </div>
  );
}
