"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { formatCount } from "../../../lib/format";
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
 *
 * Lote 3 do pente fino (18/09): aplicar é irreversível e acontecia no
 * PRIMEIRO clique. Agora o botão abre a confirmação na própria caixa, com
 * quantas linhas entram, e só o segundo clique chama a `api`. O texto dizia
 * "as linhas OK acima", e a tabela fica ABAIXO desta caixa.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export function ConfirmApplyForm({ batchId, okRows }: { batchId: string; okRows: number | null }): ReactNode {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);

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

  const linhas = okRows === null ? "As linhas OK" : `${formatCount(okRows)} ${okRows === 1 ? "linha OK" : "linhas OK"}`;

  return (
    <div className={`sb-import-apply${confirmando ? " is-confirming" : ""}`}>
      <p className="sb-import-apply-text">
        {confirmando ? (
          <>
            <strong>Confirmar a aplicação?</strong> {linhas} da tabela abaixo entram no catálogo, nos vínculos e no
            estoque. Não dá para desfazer, nem reenviando o mesmo arquivo.
          </>
        ) : (
          <>
            As linhas <strong>OK</strong> da tabela abaixo entram no catálogo, nos vínculos e no estoque. Ignoradas e
            inválidas ficam de fora. Isto não pode ser desfeito com um novo envio do mesmo arquivo.
          </>
        )}
      </p>

      {confirmando ? (
        <div className="sb-import-apply-actions">
          <button
            className="sb-button"
            type="button"
            disabled={busy}
            onClick={() => {
              setConfirmando(false);
            }}
          >
            Cancelar
          </button>
          <button
            className="sb-button sb-button-primary"
            type="button"
            onClick={() => {
              void confirm();
            }}
            disabled={busy}
          >
            {busy ? "Aplicando…" : "Sim, aplicar agora"}
          </button>
        </div>
      ) : (
        <button
          className="sb-button sb-button-primary"
          type="button"
          onClick={() => {
            setError(null);
            setConfirmando(true);
          }}
        >
          Confirmar aplicação
        </button>
      )}

      {error !== null && (
        <p role="alert" className="sb-import-apply-error">
          {error}
        </p>
      )}
    </div>
  );
}
