"use client";

import { useState, type ReactNode } from "react";

import { createClient } from "../../lib/supabase/browser";

/**
 * Início da autorização de loja Shopee (`POST /v1/shopee/connect`, D-425).
 *
 * O mesmo desenho do `ConnectButton` do Mercado Livre: a `api` monta o link
 * (a Partner Key nunca chega ao navegador) e o navegador vai inteiro para a
 * Shopee. Sem `id` de loja: na Shopee a loja só é conhecida no retorno.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

interface ConnectResponse {
  authorizationUrl: string;
}

interface ErrorResponse {
  error: { code: string; message?: string };
}

export function ShopeeConnectButton(): ReactNode {
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
      response = await fetch(`${API_URL}/v1/shopee/connect`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      setError("Não foi possível contatar o servidor. Tente novamente.");
      setBusy(false);

      return;
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as ErrorResponse | null;

      setError(
        response.status === 503
          ? "A conexão com a Shopee ainda não foi ligada no servidor."
          : (body?.error.message ?? "Não foi possível iniciar a conexão."),
      );
      setBusy(false);

      return;
    }

    const body = (await response.json()) as ConnectResponse;

    // Página inteira de propósito: é a Shopee pedindo login e autorização.
    window.location.href = body.authorizationUrl;
  }

  return (
    <div className="sb-account-connect">
      <button
        className="sb-button sb-button-primary"
        type="button"
        onClick={() => {
          void connect();
        }}
        disabled={busy}
      >
        {busy ? "Abrindo a Shopee…" : "Conectar loja Shopee"}
      </button>

      {error !== null && (
        <span role="alert" className="sb-account-connect-error">
          {error}
        </span>
      )}
    </div>
  );
}
