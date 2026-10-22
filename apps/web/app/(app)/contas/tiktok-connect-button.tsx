"use client";

import { useState, type ReactNode } from "react";

import { avisoDaConexaoTiktok, type AvisoDaConexao } from "../../../lib/conexao-tiktok";
import { createClient } from "../../../lib/supabase/browser";

/**
 * Início da autorização de loja do TikTok Shop (`POST /v1/tiktok-shop/connect`,
 * C-86 do A1, D-645; a tela é a D-652).
 *
 * O mesmo desenho do botão da Shopee: a `api` monta o link (o app secret nunca
 * chega ao navegador) e o navegador vai inteiro para o TikTok. Sem `id` de loja:
 * a loja só é conhecida no retorno.
 *
 * O que ele diz para cada resposta que não é o link mora em
 * `lib/conexao-tiktok.ts`.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

interface ConnectResponse {
  authorizationUrl: string;
}

export function TiktokConnectButton(): ReactNode {
  const [busy, setBusy] = useState(false);
  const [aviso, setAviso] = useState<AvisoDaConexao | null>(null);

  async function connect(): Promise<void> {
    setBusy(true);
    setAviso(null);

    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (token === undefined) {
      setAviso(avisoDaConexaoTiktok(401));
      setBusy(false);

      return;
    }

    let response: Response;

    try {
      response = await fetch(`${API_URL}/v1/tiktok-shop/connect`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      setAviso({ tom: "erro", texto: "Não foi possível contatar o servidor. Tente novamente." });
      setBusy(false);

      return;
    }

    if (!response.ok) {
      setAviso(avisoDaConexaoTiktok(response.status));
      setBusy(false);

      return;
    }

    const body = (await response.json()) as ConnectResponse;

    // Página inteira de propósito: é o TikTok pedindo login e autorização.
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
        {busy ? "Abrindo o TikTok Shop…" : "Conectar loja do TikTok Shop"}
      </button>

      {aviso !== null &&
        (aviso.tom === "erro" ? (
          <span role="alert" className="sb-account-connect-error">
            {aviso.texto}
          </span>
        ) : (
          <span role="status" className="sb-account-connect-note">
            {aviso.texto}
          </span>
        ))}
    </div>
  );
}
