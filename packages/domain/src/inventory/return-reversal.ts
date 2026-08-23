import { EVENT_SEVERITY } from "../events/catalog.js";
import type { DomainEventDraft } from "../events/order-events.js";
import type { RecordedSaleMovement } from "./cancellation-reversal.js";
import type { StockMovementDraft } from "./sale-deduction.js";

/**
 * Reversão de estoque por devolução (pós-venda, D-057) — a peça pura de
 * `apps/worker/src/handlers/claim-return.ts`, chamada quando uma devolução
 * associada a um claim do Mercado Livre chega em `status = "delivered"`
 * (produto fisicamente de volta — `docs/MERCADO_LIVRE.md` secao 2.10).
 *
 * Mesmo princípio de `computeCancellationReversals`: reverte os movimentos
 * `VENDA_ML` JÁ GRAVADOS, nunca recalcula dos itens atuais (D-020 — o
 * vínculo pode ter mudado entre a venda e a devolução). A diferença é o
 * ESCOPO: cancelamento reverte o pedido inteiro; devolução reverte só o
 * ITEM devolvido, localizado pelo prefixo da `idempotency_key` da venda
 * (`venda:{orderId}:{position}` — `sale-deduction.ts` — cobre tanto PRODUTO
 * quanto todos os componentes de um KIT na mesma posição).
 *
 * **Devolução PARCIAL de um item fica de fora de propósito nesta fatia**:
 * reverter proporcionalmente exigiria decidir como arredondar a fração de
 * cada componente de um KIT sem nenhum caso real para calibrar a regra
 * (mesmo raciocínio de "evidência medida" já usado em D-037/D-039/D-053) —
 * em vez de inventar uma proporção, o evento sai com `needsManualReview:
 * true` e nenhum movimento é gravado; o ajuste manual (`/estoque`, já
 * implementado) é o caminho até essa regra ter dado real para se basear.
 */

export interface ReturnedOrderItem {
  readonly position: number;
  readonly totalQuantity: number;
  readonly returnQuantity: number;
}

export interface ReturnReversal {
  readonly movements: readonly StockMovementDraft[];
  /** `false` = devolução parcial, nenhum movimento gerado — ver nota acima. */
  readonly fullReversal: boolean;
  readonly event: DomainEventDraft;
}

export function computeReturnReversal(
  order: { id: number },
  item: ReturnedOrderItem,
  saleMovements: readonly RecordedSaleMovement[],
  claimId: string,
  occurredAt: Date,
): ReturnReversal {
  const prefix = `venda:${String(order.id)}:${String(item.position)}`;
  const matched = saleMovements.filter(
    (m) => m.idempotencyKey === prefix || m.idempotencyKey.startsWith(`${prefix}:`),
  );

  const fullReversal = item.returnQuantity >= item.totalQuantity && matched.length > 0;

  const movements: StockMovementDraft[] = fullReversal
    ? matched.map((m) => ({
        skuId: m.skuId,
        qtyDelta: -m.qtyDelta,
        idempotencyKey: `devolucao:${claimId}:${m.idempotencyKey}`,
        occurredAt,
      }))
    : [];

  const eventType = "order.returned";

  return {
    movements,
    fullReversal,
    event: {
      eventType,
      entityType: "order",
      entityId: String(order.id),
      before: { claimId, position: item.position, totalQuantity: item.totalQuantity },
      after: {
        claimId,
        returnQuantity: item.returnQuantity,
        fullReversal,
        movementsReversed: movements.length,
        needsManualReview: !fullReversal,
      },
      severity: EVENT_SEVERITY[eventType] ?? "importante",
      source: "sync",
      dedupKey: `${eventType}:${claimId}:${String(item.position)}`,
      occurredAt,
    },
  };
}
