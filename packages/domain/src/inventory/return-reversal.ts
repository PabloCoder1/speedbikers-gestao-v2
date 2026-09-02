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

/**
 * O evento da devolução que NÃO pôde ser revertida (D-208).
 *
 * `computeReturnReversal` acima pressupõe que a linha de `order_items`
 * existe — é dela que sai a `position`, que é como a venda original é
 * localizada (`venda:{orderId}:{position}`). Quando ela NÃO existe, o
 * handler não tem como reverter nada, e até aqui apenas registrava um
 * `logger.warn` e seguia: o pedido continuava deduzido do estoque para
 * sempre e **o banco não guardava nenhum vestígio disso**.
 *
 * É a classe D-131 de novo — "não quebra, mente". O job fecha `done`, a
 * contagem de processados vem menor, e nada distingue essa perda de um
 * no-op legítimo (que é comum: D-205 mediu 4.903 execuções de
 * `post_purchase` que são filtro de domínio saudável). O único rastro
 * ficava no log do Cloud Run, que ninguém consulta.
 *
 * Este evento existe para que a perda seja CONSULTÁVEL onde a casa já
 * olha. Ele não conserta o estoque — não há o que consertar sem o item,
 * que só o Mercado Livre tem — e não faz o job falhar: repetir a busca
 * não faria a linha aparecer, então retentativa seria só ruído (mesmo
 * raciocínio de `permanentFailure` em D-202).
 *
 * `critico` é medido, não é ênfase: em 338.791 pedidos existem DOIS sem
 * `order_items` (2026-09-02), ambos `delivered` desde julho e sem nenhuma
 * reclamação — ou seja, este evento teria disparado ZERO vezes em toda a
 * história da base. A lição de D-135 é que um `critico` que dispara o
 * tempo todo apaga o significado do nível; este só dispara quando estoque
 * real fica preso, e aí precisa mesmo de gente.
 */
export function computeUnreversedReturn(
  order: { id: number },
  item: { itemId: string; variationId: string | null; returnQuantity: number },
  claimId: string,
  occurredAt: Date,
): DomainEventDraft {
  const eventType = "order.return.unreversed";

  return {
    eventType,
    entityType: "order",
    entityId: String(order.id),
    before: { claimId, itemId: item.itemId, variationId: item.variationId },
    after: {
      claimId,
      returnQuantity: item.returnQuantity,
      reason: "order_item_not_found",
      needsManualReview: true,
    },
    severity: EVENT_SEVERITY[eventType] ?? "critico",
    source: "sync",
    // Sem `position` (é exatamente ela que falta), a identidade do fato é
    // o item devolvido dentro do claim. `variationId` entra porque o mesmo
    // `item_id` pode voltar em variações diferentes do mesmo claim.
    dedupKey: `${eventType}:${claimId}:${String(order.id)}:${item.itemId}:${item.variationId ?? "-"}`,
    occurredAt,
  };
}
