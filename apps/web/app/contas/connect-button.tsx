"use client";

import { useState, type ReactNode } from "react";

import { createClient } from "../../lib/supabase/browser";

/**
 * Início da autorização OAuth de uma conta (`POST /v1/ml-accounts/connect`,
 * `docs/API.md` secao 2).
 *
 * Chama a `api` direto do navegador — não uma Server Action — pelo mesmo
 * motivo do upload da planilha (`apps/web/app/importacoes/nova/upload-form.tsx`):
 * o `web` nunca fala com o Mercado Livre, e é a `api` quem monta a
 * `authorizationUrl` usando o `client_id` (segredo que o navegador nunca vê).
 * O token da sessão vai no header `Authorization`; a `api` reavalia o papel
 * no banco.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

interface ConnectResponse {
  authorizationUrl: string;
}

interface ErrorResponse {
  error: { code: string; message?: string };
}

export function ConnectButton({ mlAccountId, label }: { mlAccountId: string; label: string }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(): Promise<void> {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (token === undefined) {
      setError("Sua sessão expirou. Entre de novo.");
      setBusy(false);

      return;
    }

    let response: Response;

    try {
      response = await fetch(`${API_URL}/v1/ml-accounts/connect`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ mlAccountId }),
      });
    } catch {
      setError("Não foi possível contatar o servidor. Tente novamente.");
      setBusy(false);

      return;
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as ErrorResponse | null;

      setError(body?.error.message ?? "Não foi possível iniciar a conexão.");
      setBusy(false);

      return;
    }

    const body = (await response.json()) as ConnectResponse;

    // Redirecionamento de página inteira DE PROPÓSITO — é o Mercado Livre
    // pedindo login e consentimento; não é uma chamada de API comum.
    window.location.href = body.authorizationUrl;
  }

  return (
    <div style={{ display: "inline-flex", flexDirection: "column", gap: "0.25rem", alignItems: "flex-start" }}>
      <button
        type="button"
        onClick={() => {
          void connect();
        }}
        disabled={busy}
        aria-label={`Conectar ${label} ao Mercado Livre`}
        style={{
          padding: "0.375rem 0.875rem",
          borderRadius: "var(--sb-radius)",
          border: "none",
          background: "var(--sb-primary)",
          color: "var(--sb-white)",
          fontWeight: 600,
          fontSize: "0.8125rem",
          cursor: busy ? "not-allowed" : "pointer",
          opacity: busy ? 0.6 : 1,
          whiteSpace: "nowrap",
        }}
      >
        {busy ? "Abrindo o Mercado Livre…" : "Conectar"}
      </button>

      {error !== null && (
        <span role="alert" style={{ fontSize: "0.75rem", color: "var(--sb-danger)" }}>
          {error}
        </span>
      )}
    </div>
  );
}
