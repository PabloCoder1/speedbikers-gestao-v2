"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { formatCount } from "../../lib/format";
import { markAllNotificationsRead } from "./actions";

export function MarkAllButton({ unreadCount }: { unreadCount: number }): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await markAllNotificationsRead();

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    // A lista é Server Component (não recebe o novo `readAt` por props) —
    // `revalidatePath` na action já invalida o cache, `refresh()` busca a
    // versão nova. Mesmo raciocínio de `router.push` em command-palette.tsx.
    router.refresh();
  }

  if (!confirming) {
    return (
      <button
        className="sb-button"
        type="button"
        onClick={() => {
          setConfirming(true);
        }}
      >
        Marcar todas como lidas
      </button>
    );
  }

  return (
    <div className="sb-notification-mark-all-confirm" role="group" aria-label="Confirmar leitura de todas as notificações">
      <span>
        Marcar {formatCount(unreadCount)} {unreadCount === 1 ? "notificação" : "notificações"} como lida
        {unreadCount === 1 ? "" : "s"}?
      </span>
      <button
        className="sb-button sb-button-primary"
        type="button"
        disabled={busy}
        onClick={() => {
          void handleClick();
        }}
      >
        {busy ? "Marcando…" : "Confirmar"}
      </button>
      <button
        className="sb-button"
        type="button"
        disabled={busy}
        onClick={() => {
          setConfirming(false);
          setError(null);
        }}
      >
        Cancelar
      </button>

      {error !== null && (
        <p className="sb-notification-mark-all-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
