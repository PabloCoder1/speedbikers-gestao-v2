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
  const [showReceivePrompt, setShowReceivePrompt] = useState(false);

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
    <div className="sb-pod-actions">
      {actions.includes("APPROVE") && (
        <button
          className="sb-button sb-button-primary"
          type="button"
          disabled={busy}
          onClick={() => {
            void run(() => approvePurchaseOrder(purchaseOrderId));
          }}
        >
          Aprovar
        </button>
      )}

      {actions.includes("MARK_ORDERED") && (
        <button
          className="sb-button sb-button-primary"
          type="button"
          disabled={busy}
          onClick={() => {
            void run(() => markPurchaseOrderOrdered(purchaseOrderId, expectedAt));
          }}
        >
          Marcar como enviado pelo fornecedor
        </button>
      )}

      {/* Receber dá ENTRADA no estoque local e tira do trânsito — pede um
          segundo clique, na própria caixa (lote 4 do pente fino, 18/09). */}
      {actions.includes("RECEIVE") && !showReceivePrompt && (
        <button
          className="sb-button sb-button-primary"
          type="button"
          disabled={busy}
          onClick={() => {
            setShowReceivePrompt(true);
          }}
        >
          Confirmar recebimento
        </button>
      )}

      {actions.includes("RECEIVE") && showReceivePrompt && (
        <div className="sb-pod-confirm" role="group" aria-label="Confirmar recebimento">
          <span>Receber o pedido dá entrada de todos os itens no estoque local. Não dá para desfazer por aqui.</span>
          <button
            className="sb-button sb-button-primary"
            type="button"
            disabled={busy}
            onClick={() => {
              void run(() => receivePurchaseOrder(purchaseOrderId));
            }}
          >
            {busy ? "Recebendo…" : "Sim, receber"}
          </button>
          <button
            className="sb-button"
            type="button"
            disabled={busy}
            onClick={() => {
              setShowReceivePrompt(false);
            }}
          >
            Voltar
          </button>
        </div>
      )}

      {actions.includes("CANCEL") && !showCancelPrompt && (
        <button
          className="sb-button"
          type="button"
          disabled={busy}
          onClick={() => {
            setShowCancelPrompt(true);
          }}
          data-tom="perigo"
        >
          Cancelar pedido
        </button>
      )}

      {actions.includes("CANCEL") && showCancelPrompt && (
        <div className="sb-pod-confirm" role="group" aria-label="Confirmar cancelamento">
          <input
            className="sb-input"
            aria-label="Motivo do cancelamento (opcional)"
            value={cancelReason}
            onChange={(event) => {
              setCancelReason(event.target.value);
            }}
            placeholder="Motivo (opcional)"
          />
          <button
            className="sb-button"
            type="button"
            disabled={busy}
            onClick={() => {
              void run(() => cancelPurchaseOrder(purchaseOrderId, cancelReason.trim() === "" ? null : cancelReason.trim()));
            }}
          >
            Confirmar cancelamento
          </button>
          <button
            className="sb-button"
            type="button"
            disabled={busy}
            onClick={() => {
              setShowCancelPrompt(false);
            }}
          >
            Voltar
          </button>
        </div>
      )}

      {error !== null && (
        <p role="alert" className="sb-pod-actions-error">
          {error}
        </p>
      )}
    </div>
  );
}
