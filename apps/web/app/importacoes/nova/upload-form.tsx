"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { createClient } from "../../../lib/supabase/browser";
import { describeUploadResponse, type UploadMessage } from "./describe-response";

/**
 * Envio da exportação do UpSeller.
 *
 * O arquivo vai do navegador DIRETO para a `api`, sem passar pela Vercel. Dois
 * motivos: o limite de corpo da função da Vercel deixaria de ser um problema
 * nosso, e a `api` já é quem sabe guardar no bucket, calcular o hash e
 * enfileirar o parse. O CORS de `/v1/*` é o que autoriza essa chamada.
 *
 * O token da sessão vai no header `Authorization`. A `api` reavalia o papel no
 * banco — a interface esconder o formulário não é autorização.
 */

const KINDS = [
  { value: "PRODUCTS", label: "Produtos", hint: "cadastro de SKU, preço, custo e dimensões" },
  { value: "KITS", label: "Kits", hint: "composição: kit e seus componentes" },
  { value: "LINKS", label: "Vínculos", hint: "SKU ↔ anúncio de cada loja" },
  { value: "STOCK", label: "Estoque", hint: "saldo por armazém" },
] as const;

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export function UploadForm(): ReactNode {
  const router = useRouter();

  const [kind, setKind] = useState<string>("PRODUCTS");
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

    body.set("kind", kind);
    body.set("file", file);

    let response: Response;

    try {
      response = await fetch(`${API_URL}/v1/erp-imports`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body,
      });
    } catch {
      // Rede caiu, CORS barrou, api fora do ar — do navegador os três são
      // indistinguíveis, e nenhum deles é culpa de quem está enviando.
      setMessage({ tone: "bad", text: "Não foi possível falar com o servidor. Tente de novo." });
      setBusy(false);

      return;
    }

    const payload: unknown = await response.json().catch(() => null);
    const result = describeUploadResponse(response.status, payload);

    if (result.batchId !== null) {
      router.push(`/importacoes/${result.batchId}`);

      return;
    }

    setMessage(result.message);
    setBusy(false);
  }

  const selected = KINDS.find((option) => option.value === kind);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      style={{ display: "grid", gap: "var(--sb-space-3)", maxWidth: "32rem" }}
    >
      <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
        Qual arquivo é este?
        <select
          value={kind}
          onChange={(event) => {
            setKind(event.target.value);
          }}
          style={{
            display: "block",
            width: "100%",
            marginTop: "var(--sb-space-1)",
            padding: "0.5rem",
            borderRadius: "var(--sb-radius)",
            border: "1px solid var(--sb-border)",
            fontSize: "1rem",
          }}
        >
          {KINDS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {selected !== undefined && (
        <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
          {selected.hint}. O tipo errado é recusado na leitura, pelas colunas do cabeçalho — nada é
          aplicado por engano.
        </p>
      )}

      <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
        Arquivo (.xlsx)
        <input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
          }}
          required
          style={{ display: "block", width: "100%", marginTop: "var(--sb-space-1)" }}
        />
      </label>

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
        Enviar não altera nada. O arquivo é lido e o resultado fica em conferência até você
        confirmar.
      </p>
    </form>
  );
}
