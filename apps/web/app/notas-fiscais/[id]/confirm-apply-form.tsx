"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { createClient } from "../../../lib/supabase/browser";

/**
 * Confirmação humana da aplicação da NF-e.
 *
 * Mesmo padrão de `apps/web/app/importacoes/[id]/confirm-apply-form.tsx`,
 * com uma diferença: só fica habilitado quando TODOS os itens estão
 * vinculados (`confirmNfeApply` recusaria de qualquer forma — o botão
 * desabilitado evita a viagem ao servidor só para ouvir "não").
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export function ConfirmApplyForm({
  documentId,
  totalItems,
  resolvedItems,
}: {
  documentId: string;
  totalItems: number;
  resolvedItems: number;
}): ReactNode {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = totalItems > 0 && resolvedItems === totalItems;

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
      response = await fetch(`${API_URL}/v1/nfe-imports/${documentId}/apply`, {
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
        background: "var(--sb-surface)",
      }}
    >
      <p style={{ margin: 0, fontSize: "0.875rem", flex: "1 1 20rem" }}>
        {ready ? (
          <>
            Todos os <strong>{totalItems}</strong> itens estão vinculados. Confirmar gera os movimentos de
            estoque desta nota. Isto não pode ser desfeito com um novo envio do mesmo arquivo.
          </>
        ) : (
          <>
            <strong>
              {resolvedItems} de {totalItems}
            </strong>{" "}
            itens vinculados. Vincule todos os itens abaixo antes de confirmar — uma nota fiscal só é
            aplicada por completo, nunca parcialmente.
          </>
        )}
      </p>

      <button
        type="button"
        onClick={() => {
          void confirm();
        }}
        disabled={busy || !ready}
        style={{
          padding: "0.625rem 1rem",
          border: "none",
          borderRadius: "var(--sb-radius)",
          background: "var(--sb-primary)",
          color: "var(--sb-white)",
          fontSize: "1rem",
          fontWeight: 600,
          cursor: busy || !ready ? "not-allowed" : "pointer",
          opacity: busy || !ready ? 0.6 : 1,
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
