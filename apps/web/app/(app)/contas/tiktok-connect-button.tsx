"use client";

import { useState, type ReactNode } from "react";

import { iniciarConexaoOAuth } from "./iniciar-conexao";

/**
 * Início da autorização de loja TikTok Shop (`POST /v1/tiktok-shop/connect`, D-645 / D-822).
 *
 * Mesmo desenho do `ShopeeConnectButton`: a `api` monta o link (App Key e App
 * Secret nunca chegam ao navegador) e o navegador segue para o Partner Center
 * do TikTok Shop. A loja só é conhecida no retorno do OAuth.
 */

export function TikTokConnectButton(): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(): Promise<void> {
    setBusy(true);
    setError(null);

    const resultado = await iniciarConexaoOAuth({
      caminho: "/v1/tiktok-shop/connect",
      mensagem503: "A conexão com o TikTok Shop ainda não foi ligada no servidor.",
    });

    if (!resultado.ok) {
      setError(resultado.mensagem);
      setBusy(false);

      return;
    }

    window.location.href = resultado.authorizationUrl;
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
        {busy ? "Abrindo o TikTok Shop…" : "Conectar loja TikTok Shop"}
      </button>

      {error !== null && (
        <span role="alert" className="sb-account-connect-error">
          {error}
        </span>
      )}
    </div>
  );
}
