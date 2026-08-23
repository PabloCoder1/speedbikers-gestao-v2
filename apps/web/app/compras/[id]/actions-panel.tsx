"use client";

import { availablePurchaseOrderActions } from "@sb/domain";
import type { PurchaseOrderStatus } from "@sb/domain";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  markPurchaseOrderOrdered,
  receivePurchaseOrder,
} from "../actions";

/**
 * Painel de ações do pedido — as ações disponíveis vêm de
 * `availablePurchaseOrderActions` (`@sb/domain/purchasing`, pura): decide
 * o que MOSTRAR, não o que é permitido — a RPC recusa de qualquer forma se
 * o estado mudou entre a renderização e o clique (corrida benigna).
 *
 * Edição do rascunho (`UPDATE`) ainda não tem tela — a RPC
 * (`update_purchase_order_draft`) já existe e funciona, fica para uma
 * próxima etapa.
 */

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 0.875rem",
  borderRadius: "var(--sb-radius)",
  border: "none",
  fontSize: "0.875rem",
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export function ActionsPanel({
  purchaseOrderId,
  status,
  expectedAt,
}: {
  purchaseOrderId: string;
  status: string;
  expectedAt: string | null;
}): ReactNode {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [showCancelPrompt, setShowCancelPrompt] = useState(false);

  const actions = availablePurchaseOrderActions(status as PurchaseOrderStatus);

  async function run(action: () => Promise<{ ok: boolean; message: string | null }>): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await action();

    if (!result.ok) {
      setError(result.message);
      setBusy(false);

      return;
    }

    setShowCancelPrompt(false);
    setBusy(false);
    router.refresh();
  }

  if (actions.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        display: "flex",
        gap: "var(--sb-space-2)",
        alignItems: "flex-start",
        flexWrap: "wrap",
        margin: "var(--sb-space-3) 0",
        padding: "var(--sb-space-3)",
        border: "1px solid var(--sb-border)",
        borderRadius: "var(--sb-radius)",
      }}
    >
      {actions.includes("APPROVE") && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void run(() => approvePurchaseOrder(purchaseOrderId));
          }}
          style={{ ...buttonStyle, background: "var(--sb-primary)", color: "var(--sb-white)" }}
        >
          Aprovar
        </button>
      )}

      {actions.includes("MARK_ORDERED") && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void run(() => markPurchaseOrderOrdered(purchaseOrderId, expectedAt));
          }}
          style={{ ...buttonStyle, background: "var(--sb-primary)", color: "var(--sb-white)" }}
        >
          Marcar como enviado pelo fornecedor
        </button>
      )}

      {actions.includes("RECEIVE") && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void run(() => receivePurchaseOrder(purchaseOrderId));
          }}
          style={{ ...buttonStyle, background: "var(--sb-secondary)", color: "var(--sb-white)" }}
        >
          Confirmar recebimento
        </button>
      )}

      {actions.includes("CANCEL") && !showCancelPrompt && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setShowCancelPrompt(true);
          }}
          style={{ ...buttonStyle, background: "transparent", border: "1px solid var(--sb-border)", color: "var(--sb-danger)" }}
        >
          Cancelar pedido
        </button>
      )}

      {actions.includes("CANCEL") && showCancelPrompt && (
        <div style={{ display: "flex", gap: "var(--sb-space-2)", alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={cancelReason}
            onChange={(event) => {
              setCancelReason(event.target.value);
            }}
            placeholder="Motivo (opcional)"
            style={{
              padding: "0.375rem 0.5rem",
              borderRadius: "var(--sb-radius)",
              border: "1px solid var(--sb-border)",
              fontSize: "0.8125rem",
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void run(() => cancelPurchaseOrder(purchaseOrderId, cancelReason.trim() === "" ? null : cancelReason.trim()));
            }}
            style={{ ...buttonStyle, background: "var(--sb-danger)", color: "var(--sb-white)" }}
          >
            Confirmar cancelamento
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setShowCancelPrompt(false);
            }}
            style={{ ...buttonStyle, background: "transparent", color: "var(--sb-text-soft)" }}
          >
            Voltar
          </button>
        </div>
      )}

      {error !== null && (
        <p role="alert" style={{ margin: 0, fontSize: "0.875rem", color: "var(--sb-danger)", flexBasis: "100%" }}>
          {error}
        </p>
      )}
    </div>
  );
}
