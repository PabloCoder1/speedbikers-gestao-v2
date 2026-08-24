"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { markAllNotificationsRead } from "./actions";

export function MarkAllButton(): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
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

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.25rem" }}>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void handleClick();
        }}
        style={{
          padding: "0.375rem 0.75rem",
          borderRadius: "var(--sb-radius)",
          border: "1px solid var(--sb-border)",
          background: "transparent",
          fontSize: "0.8125rem",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        Marcar todas como lidas
      </button>

      {error !== null && (
        <p role="alert" style={{ margin: 0, fontSize: "0.75rem", color: "var(--sb-danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
