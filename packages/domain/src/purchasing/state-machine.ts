/**
 * Máquina de estados do pedido de compra (Fase 4, docs/ROADMAP.md) — pura,
 * sem I/O. A fonte da verdade da transição em si é a RPC SQL
 * (`supabase/migrations/20260822234353_create_purchasing.sql`, que refaz a
 * checagem internamente); esta função existe para a UI decidir quais ações
 * mostrar/desabilitar sem uma viagem ao servidor só para ouvir "não".
 *
 * Ciclo: DRAFT -> APPROVED -> ORDERED -> RECEIVED, com CANCELLED alcançável
 * de qualquer estado não-terminal. Recebimento é tudo-ou-nada nesta
 * primeira fatia (sem PARTIALLY_RECEIVED) — ver comentário no topo da
 * migration para o porquê.
 */

export type PurchaseOrderStatus = "DRAFT" | "APPROVED" | "ORDERED" | "RECEIVED" | "CANCELLED";

export type PurchaseOrderAction = "UPDATE" | "APPROVE" | "MARK_ORDERED" | "RECEIVE" | "CANCEL";

const TERMINAL_STATUSES: ReadonlySet<PurchaseOrderStatus> = new Set(["RECEIVED", "CANCELLED"]);

export function isTerminalPurchaseOrderStatus(status: PurchaseOrderStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function availablePurchaseOrderActions(status: PurchaseOrderStatus): PurchaseOrderAction[] {
  const actions: PurchaseOrderAction[] = [];

  if (status === "DRAFT") {
    actions.push("UPDATE", "APPROVE");
  }

  if (status === "APPROVED") {
    actions.push("MARK_ORDERED");
  }

  if (status === "ORDERED") {
    actions.push("RECEIVE");
  }

  if (!isTerminalPurchaseOrderStatus(status)) {
    actions.push("CANCEL");
  }

  return actions;
}
