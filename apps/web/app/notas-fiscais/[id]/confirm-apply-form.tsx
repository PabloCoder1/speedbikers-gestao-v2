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
    /*
      A barra fica presa ao pé da tela (`position: sticky`) enquanto a pessoa
      desce pela lista de itens: é o lugar onde o "quanto falta" e o botão
      precisam estar quando o último vínculo é feito, não lá em cima.
    */
    <div className={ready ? "sb-nf-confirmar sb-nf-confirmar-pronto" : "sb-nf-confirmar"}>
      <div className="sb-nf-confirmar-texto">
        {ready ? (
          <>
            <b>Tudo vinculado — {totalItems} de {totalItems} itens.</b>
            <span>
              Confirmar gera os movimentos de estoque deste documento. Isto não pode ser desfeito com um novo envio do
              mesmo arquivo.
            </span>
          </>
        ) : (
          <>
            <b>
              {resolvedItems} de {totalItems} itens vinculados
            </b>
            <span>Vincule todos antes de confirmar — um documento só é aplicado por completo, nunca parcialmente.</span>
          </>
        )}
        {error !== null && (
          <p role="alert" className="sb-nf-confirmar-erro">
            {error}
          </p>
        )}
      </div>

      <button
        className="sb-button sb-button-primary"
        type="button"
        onClick={() => {
          void confirm();
        }}
        disabled={busy || !ready}
      >
        {busy ? "Confirmando…" : "Confirmar aplicação"}
      </button>
    </div>
  );
}
