import { isCancelledOrderStatus } from "../events/order-events.js";
import type { StockMovementDraft } from "./sale-deduction.js";

/**
 * Reversão de estoque por cancelamento — a peça pura de
 * `apps/worker/src/handlers/persist-order.ts`, chamada a cada order
 * persistida cujo status é de cancelamento (`docs/ROADMAP.md`, segundo item
 * do checklist da Fase 4, depois de `computeSaleDeductions`).
 *
 * Reverte os movimentos `VENDA_ML` JÁ GRAVADOS no ledger — não recalcula a
 * dedução a partir dos itens atuais do pedido. `sku_id` é resolvido fresco a
 * cada persistência (D-020): o vínculo pode ter mudado entre a venda e o
 * cancelamento, e recomputar geraria uma reversão para um SKU que nunca foi
 * de fato deduzido. Reverter exatamente o que foi lançado — não o que se
 * lançaria hoje — é a única forma de o ledger fechar em zero para esta
 * order, e dispensa qualquer conhecimento de KIT/componentes aqui: o
 * ledger já tem a decomposição certa gravada.
 *
 * Devolução (`order.returned`) fica de fora de propósito, mesmo motivo já
 * registrado em `@sb/domain/events` (`order-events.ts`): o Mercado Livre
 * modela devolução pela API de Reclamações e Devoluções, não integrada.
 */

export interface RecordedSaleMovement {
  readonly skuId: string;
  /** Sempre negativo — a dedução original gravada por `computeSaleDeductions`. */
  readonly qtyDelta: number;
  readonly idempotencyKey: string;
}

export interface CancellationReversalOrder {
  readonly id: number;
  readonly status: string;
  /** `orders.date_last_updated` — quando o cancelamento aconteceu de verdade. */
  readonly occurredAt: Date;
}

export function computeCancellationReversals(
  order: CancellationReversalOrder,
  saleMovements: readonly RecordedSaleMovement[],
): StockMovementDraft[] {
  if (!isCancelledOrderStatus(order.status)) {
    return [];
  }

  return saleMovements.map((movement) => ({
    skuId: movement.skuId,
    qtyDelta: -movement.qtyDelta,
    idempotencyKey: `cancelamento:${movement.idempotencyKey}`,
    occurredAt: order.occurredAt,
  }));
}
