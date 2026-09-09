"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";

import { safeNext } from "../../lib/safe-next";
import { createClient, missingBrowserEnv } from "../../lib/supabase/browser";

/**
 * Formulário de entrada.
 *
 * Sistema interno: acesso é concedido pelo ADMIN, não por autocadastro. Por
 * isso não há "criar conta" — quem não tem acesso pede a quem administra.
 */
export function LoginForm(): ReactNode {
  const router = useRouter();
  const params = useSearchParams();

  const missing = missingBrowserEnv();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const result = await supabase.auth.signInWithPassword({ email, password });

    if (result.error !== null) {
      // Mensagem genérica de propósito: distinguir "e-mail não existe" de
      // "senha errada" entrega ao atacante quais endereços são válidos.
      setError("E-mail ou senha incorretos.");
      setBusy(false);

      return;
    }

    router.replace(safeNext(params.get("next")));
    router.refresh();
  }

  if (missing.length > 0) {
    return (
      <p role="alert" style={{ color: "var(--sb-danger)", fontSize: "0.875rem" }}>
        Ambiente incompleto. Falta definir na Vercel: {missing.join(", ")}.
      </p>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      style={{ display: "grid", gap: "var(--sb-space-3)" }}>
      <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
        E-mail
        <input
          className="sb-input"
          type="email"
          value={email}
          onChange={(event) => { setEmail(event.target.value); }}
          required
          autoComplete="email"
        />
      </label>

      <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
        Senha
        <input
          className="sb-input"
          type="password"
          value={password}
          onChange={(event) => { setPassword(event.target.value); }}
          required
          autoComplete="current-password"
        />
      </label>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)", fontSize: "0.875rem", margin: 0 }}>
          {error}
        </p>
      )}

      <button
        className="sb-button sb-button-primary"
        type="submit"
        disabled={busy}
      >
        {busy ? "Entrando…" : "Entrar"}
      </button>

      <p style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem", margin: 0 }}>
        Acesso é concedido pelo administrador. Não há autocadastro.
      </p>
    </form>
  );
}
