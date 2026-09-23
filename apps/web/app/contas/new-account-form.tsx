"use client";

import { useId, useState, type ReactNode, type SyntheticEvent } from "react";

import { createMlAccount } from "./actions";

/**
 * Cadastro de uma conta Mercado Livre antes da autorização OAuth.
 *
 * A escrita cria somente a linha `PENDING` em `ml_accounts`; conectar de fato
 * continua sendo uma ação separada, porque só a API conhece o client_secret.
 */
export function NewAccountForm(): ReactNode {
  const [label, setLabel] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const errorId = useId();
  const successId = useId();

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await createMlAccount(label, slug);

      if (!result.ok) {
        setError(result.message ?? "Não foi possível criar a conta.");

        return;
      }

      setLabel("");
      setSlug("");
      setSuccess("Conta cadastrada. Use Conectar no cartão criado para concluir a autorização no Mercado Livre.");
    } catch {
      setError("Não foi possível criar a conta agora. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  const feedbackId = error === null ? (success === null ? undefined : successId) : errorId;

  return (
    <form className="sb-account-form" aria-label="Cadastrar uma conta Mercado Livre" onSubmit={(event) => void submit(event)}>
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
          required
          aria-invalid={error === null ? undefined : true}
          aria-describedby={feedbackId}
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
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          title="Use letras minúsculas, números e hífens, sem hífen no início ou no fim."
          required
          aria-invalid={error === null ? undefined : true}
          aria-describedby={feedbackId}
        />
      </label>

      <button className="sb-button sb-button-primary" type="submit" disabled={busy || label.trim() === "" || slug.trim() === ""}>
        Cadastrar conta
      </button>

      {error !== null && (
        <p id={errorId} role="alert" className="sb-account-form-error">
          {error}
        </p>
      )}

      {success !== null && (
        <p id={successId} role="status" className="sb-account-form-success">
          {success}
        </p>
      )}
    </form>
  );
}
