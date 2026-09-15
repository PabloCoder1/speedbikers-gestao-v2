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
 *
 * **D-351 — venda estornada por ser anterior ao snapshot.** O UpSeller devolve
 * a unidade ao Disponível sozinho quando o pedido cancela (resposta do dono).
 * Então, para uma venda com `ESTORNO_PRE_CAPTURA`:
 *
 *  - cancelada DEPOIS do corte: a planilha não tem a devolução — reverte, como
 *    qualquer venda. É o pedido 2000018438280312 de produção (fechado em 09-13,
 *    cancelado às 19:07:45, depois da planilha das 18:42).
 *  - cancelada ATÉ o corte: a planilha já tem a unidade de volta — não reverte.
 *    Reverter somaria a unidade duas vezes.
 *
 * Venda sem estorno reverte sempre: se ela não foi estornada, é porque a
 * planilha não a descontou. E quando o instante do cancelamento é desconhecido
 * (sem `date_last_updated` nem `last_updated`, só `date_created`), reverte
 * também: "não sei quando" não autoriza pular uma reposição.
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
  /**
   * `false` quando `occurredAt` caiu em `date_created` porque o pedido veio sem
   * `date_last_updated` e sem `last_updated` (D-101): o instante do
   * cancelamento é desconhecido.
   */
  readonly occurredAtKnown: boolean;
}

export interface CancellationPreCapture {
  /** Chaves de `VENDA_ML` que já têm `ESTORNO_PRE_CAPTURA` gravado. */
  readonly estornadas: ReadonlySet<string>;
  /** Mesmo contrato de `PreCaptureCutoffs.cutoffFor`: lança para SKU não lido. */
  readonly cutoffFor: (skuId: string) => Date | null;
}

export function computeCancellationReversals(
  order: CancellationReversalOrder,
  saleMovements: readonly RecordedSaleMovement[],
  preCapture: CancellationPreCapture,
): StockMovementDraft[] {
  if (!isCancelledOrderStatus(order.status)) {
    return [];
  }

  return saleMovements
    .filter((movement) => {
      if (!preCapture.estornadas.has(movement.idempotencyKey) || !order.occurredAtKnown) {
        return true;
      }

      const cutoff = preCapture.cutoffFor(movement.skuId);

      return cutoff === null || order.occurredAt.getTime() > cutoff.getTime();
    })
    .map((movement) => ({
      skuId: movement.skuId,
      qtyDelta: -movement.qtyDelta,
      idempotencyKey: `cancelamento:${movement.idempotencyKey}`,
      occurredAt: order.occurredAt,
    }));
}
