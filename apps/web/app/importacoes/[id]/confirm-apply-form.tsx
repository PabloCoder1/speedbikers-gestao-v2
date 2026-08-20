"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { createClient } from "../../../lib/supabase/browser";

/**
 * Confirmação humana da aplicação.
 *
 * Último passo do fluxo `upload -> parse -> conferência -> CONFIRMAÇÃO ->
 * aplicação`. Só aparece quando o lote está `PARSED` — antes disso não há o
 * que confirmar, depois disso a `api` recusa (docs/API.md).
 *
 * O clique chama a `api`, nunca escreve na tabela direto do navegador: a
 * transição de status fica num lugar só, com validação.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export function ConfirmApplyForm({ batchId }: { batchId: string }): ReactNode {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(): Promise<void> {
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
      response = await fetch(`${API_URL}/v1/erp-imports/${batchId}/apply`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      setError("Não foi possível falar com o servidor. Tente de novo.");
      setBusy(false);

      return;
    }

    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const message =
        typeof payload === "object" && payload !== null && "error" in payload
          ? (payload as { error?: { message?: string } }).error?.message
          : undefined;

      setError(message ?? "Não foi possível confirmar a aplicação.");
      setBusy(false);

      return;
    }

    router.refresh();
  }

  return (
    <div
      style={{
        display: "flex",
        gap: "var(--sb-space-3)",
        alignItems: "center",
        flexWrap: "wrap",
        margin: "var(--sb-space-3) 0",
        padding: "var(--sb-space-3)",
        border: "1px solid var(--sb-border)",
        borderRadius: "var(--sb-radius)",
      }}
    >
      <p style={{ margin: 0, fontSize: "0.875rem", flex: "1 1 20rem" }}>
        As linhas <strong>OK</strong> acima entram no catálogo, nos vínculos e no estoque. Ignoradas e
        inválidas ficam de fora. Isto não pode ser desfeito com um novo envio do mesmo arquivo.
      </p>

      <button
        type="button"
        onClick={() => {
          void confirm();
        }}
        disabled={busy}
        style={{
          padding: "0.625rem 1rem",
          border: "none",
          borderRadius: "var(--sb-radius)",
          background: "var(--sb-primary)",
          color: "var(--sb-white)",
          fontSize: "1rem",
          fontWeight: 600,
          cursor: busy ? "not-allowed" : "pointer",
          opacity: busy ? 0.6 : 1,
          whiteSpace: "nowrap",
        }}
      >
        {busy ? "Confirmando…" : "Confirmar aplicação"}
      </button>

      {error !== null && (
        <p role="alert" style={{ margin: 0, fontSize: "0.875rem", color: "var(--sb-danger)", flexBasis: "100%" }}>
          {error}
        </p>
      )}
    </div>
  );
}
