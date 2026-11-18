"use client";

import { useState, type ReactNode } from "react";

import { iniciarConexaoOAuth } from "./iniciar-conexao";

/**
 * Início da autorização de loja Shopee (`POST /v1/shopee/connect`, D-425).
 *
 * O mesmo desenho do `ConnectButton` do Mercado Livre: a `api` monta o link
 * (a Partner Key nunca chega ao navegador) e o navegador vai inteiro para a
 * Shopee. Sem `id` de loja: na Shopee a loja só é conhecida no retorno.
 */

export function ShopeeConnectButton(): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(): Promise<void> {
    setBusy(true);
    setError(null);

    const resultado = await iniciarConexaoOAuth({
      caminho: "/v1/shopee/connect",
      mensagem503: "A conexão com a Shopee ainda não foi ligada no servidor.",
    });

    if (!resultado.ok) {
      setError(resultado.mensagem);
      setBusy(false);

      return;
    }

    // Página inteira de propósito: é a Shopee pedindo login e autorização.
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
