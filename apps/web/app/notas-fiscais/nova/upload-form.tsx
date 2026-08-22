"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { createClient } from "../../../lib/supabase/browser";
import { describeUploadResponse, type UploadMessage } from "./describe-response";

/**
 * Envio do XML da NF-e.
 *
 * Mesmo raciocínio de `apps/web/app/importacoes/nova/upload-form.tsx`: o
 * arquivo vai do navegador DIRETO para a `api` — CORS de `/v1/*` autoriza.
 * O token da sessão vai no header `Authorization`; a `api` reavalia o papel.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export function UploadForm(): ReactNode {
  const router = useRouter();

  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<UploadMessage | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (file === null) return;

    setBusy(true);
    setMessage(null);

    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (token === undefined) {
      setMessage({ tone: "bad", text: "Sua sessão expirou. Entre de novo." });
      setBusy(false);

      return;
    }

    const body = new FormData();

    body.set("file", file);

    let response: Response;

    try {
      response = await fetch(`${API_URL}/v1/nfe-imports`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body,
      });
    } catch {
      setMessage({ tone: "bad", text: "Não foi possível falar com o servidor. Tente de novo." });
      setBusy(false);

      return;
    }

    const payload: unknown = await response.json().catch(() => null);
    const result = describeUploadResponse(response.status, payload);

    if (result.documentId !== null) {
      router.push(`/notas-fiscais/${result.documentId}`);

      return;
    }

    setMessage(result.message);
    setBusy(false);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      style={{ display: "grid", gap: "var(--sb-space-3)", maxWidth: "32rem" }}
    >
      <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
        Arquivo XML da NF-e
        <input
          type="file"
          accept=".xml,application/xml,text/xml"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
          }}
          required
          style={{ display: "block", width: "100%", marginTop: "var(--sb-space-1)" }}
        />
      </label>

      <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Envie o XML, não o PDF/DANFE — é o XML que traz os campos estruturados que a conferência
        precisa. Entrada ou saída é decidido automaticamente pelo CNPJ da Speed Bikers no
        documento, não pelo tipo do arquivo.
      </p>

      {message !== null && (
        <p
          role="alert"
          style={{
            margin: 0,
            fontSize: "0.875rem",
            color: message.tone === "bad" ? "var(--sb-danger)" : "var(--sb-text-soft)",
          }}
        >
          {message.text}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || file === null}
        style={{
          padding: "0.625rem",
          border: "none",
          borderRadius: "var(--sb-radius)",
          background: "var(--sb-primary)",
          color: "var(--sb-white)",
          fontSize: "1rem",
          fontWeight: 600,
          cursor: busy || file === null ? "not-allowed" : "pointer",
          opacity: busy || file === null ? 0.6 : 1,
        }}
      >
        {busy ? "Enviando…" : "Enviar para conferência"}
      </button>

      <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Enviar não altera o estoque. O XML é lido e o resultado fica em conferência até você
        vincular os itens e confirmar.
      </p>
    </form>
  );
}
