"use client";

import { useState, type ReactNode } from "react";

/**
 * Copia o MLB — a chave que se cola no Mercado Livre, no ERP e na conversa com
 * o cliente. Com retorno visível por dois segundos: botão de copiar que não diz
 * se copiou faz a pessoa colar para conferir.
 */
export function CopiarMlb({ itemId }: { itemId: string }): ReactNode {
  const [estado, setEstado] = useState<"idle" | "ok" | "erro">("idle");

  async function copiar(): Promise<void> {
    try {
      await navigator.clipboard.writeText(itemId);
      setEstado("ok");
    } catch {
      setEstado("erro");
    }

    window.setTimeout(() => {
      setEstado("idle");
    }, 2000);
  }

  return (
    <button
      type="button"
      className="sb-button sb-anuncio-copiar"
      onClick={() => {
        void copiar();
      }}
      aria-live="polite"
    >
      {estado === "ok" ? "✓ Copiado" : estado === "erro" ? "Não copiou" : "Copiar MLB"}
    </button>
  );
}
