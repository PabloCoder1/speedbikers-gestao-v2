import { isCancelledOrderStatus } from "../events/order-events.js";
import { computeSaleDeductions, estornadoKeyOf, preCaptureEstornoOf, saleInstant } from "./sale-deduction.js";
import type {
  ErpCutoff,
  PreCaptureCutoffs,
  RecordedSale,
  SaleDeductionOrder,
  StockMovementDraft,
} from "./sale-deduction.js";

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
  readonly cutoffFor: (skuId: string) => ErpCutoff | null;
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

      return cutoff === null || order.occurredAt.getTime() > cutoff.capturedAt.getTime();
    })
    .map((movement) => ({
      skuId: movement.skuId,
      qtyDelta: -movement.qtyDelta,
      idempotencyKey: `cancelamento:${movement.idempotencyKey}`,
      occurredAt: order.occurredAt,
    }));
}

/**
 * A V3 viu o pedido em status de venda válida e depois cancelado (D-351). Vem
 * da leitura desta vez (status anterior no banco) ou de um `order.cancelled`
 * já gravado com `before.status` de venda — que sobrevive a um retry depois de
 * o pedido já ter sido regravado como cancelado.
 */
export interface ObservedSaleTransition {
  /** O status de venda em que o pedido estava antes de cancelar. */
  readonly saleStatus: string;
  /** Quando a V3 viu o cancelamento. `null` = instante desconhecido (D-101). */
  readonly cancelledAt: Date | null;
}

export interface CancellationMovementsInput {
  /** O pedido cancelado, com os itens e vínculos de hoje (`status` = o cancelado). */
  readonly order: SaleDeductionOrder;
  /** O instante do cancelamento desta leitura (`date_last_updated`), e se ele é conhecido. */
  readonly occurredAt: Date;
  readonly occurredAtKnown: boolean;
  readonly transition: ObservedSaleTransition | null;
  readonly recordedSales: readonly (RecordedSaleMovement & RecordedSale)[];
  /** Chaves de `VENDA_ML` que já têm estorno gravado. */
  readonly estornadas: ReadonlySet<string>;
  readonly cutoffFor: (skuId: string) => ErpCutoff | null;
}

export interface CancellationMovements {
  /** `VENDA_ML` que a V3 nunca gravou, de venda anterior ao corte e cancelada depois dele. */
  readonly sales: StockMovementDraft[];
  /** `ESTORNO_PRE_CAPTURA`: o par dessas vendas, e o que falta de venda já gravada. */
  readonly estornos: StockMovementDraft[];
  /** `CANCELAMENTO_ML`. */
  readonly reversals: StockMovementDraft[];
}

/**
 * Tudo o que um pedido cancelado grava no ledger (D-351), na ordem de gravação:
 * venda, estorno, cancelamento.
 *
 * **A venda nunca gravada** (revisão de D-351, ALTA-2). Pedido pago antes da
 * planilha, sem vínculo na época, e cancelado depois dela: a planilha tem a
 * venda descontada e o UpSeller devolve a unidade depois — o estoque real é o
 * snapshot +1. Sem `VENDA_ML` gravado, `computeCancellationReversals` não teria
 * o que reverter, e a V3 ficaria 1 abaixo até a próxima planilha. Então, para
 * cada rascunho de venda (vínculos de hoje) sem linha gravada, grava venda +
 * estorno + cancelamento quando TODAS valem: a V3 viu a transição de venda
 * para cancelado, `date_closed` existe, a venda é até o corte do SKU, e o
 * cancelamento tem instante conhecido e POSTERIOR ao corte. Sem a transição
 * observada, "cancelado" pode ser da carga da história — os 9 pedidos que o
 * backfill já trouxe cancelados, antes da planilha, e que não mexem.
 *
 * **O estorno que falta de venda já gravada** sai pela mesma regra da venda
 * (`preCaptureEstornoOf`). Sem ele, um retry que achasse a venda gravada e o
 * estorno não reverteria para zero em vez de +1.
 */
export function computeCancellationMovements(input: CancellationMovementsInput): CancellationMovements {
  if (!isCancelledOrderStatus(input.order.status)) {
    return { sales: [], estornos: [], reversals: [] };
  }

  const saleAt = saleInstant(input.order);
  const gravadas = new Map(input.recordedSales.map((sale) => [sale.idempotencyKey, sale]));
  const preCapture: PreCaptureCutoffs = { cutoffFor: input.cutoffFor, recordedSale: (key) => gravadas.get(key) };

  const sales: StockMovementDraft[] = [];
  const { transition } = input;
  const cancelledAt = transition?.cancelledAt ?? null;

  if (transition !== null && cancelledAt !== null && input.order.dateClosed !== null) {
    // O status da transicao passa pelo filtro de venda valida de
    // `computeSaleDeductions`: `confirmed -> cancelled` nao gera rascunho nenhum.
    const { deductions } = computeSaleDeductions({ ...input.order, status: transition.saleStatus }, preCapture);

    for (const deduction of deductions) {
      if (gravadas.has(deduction.idempotencyKey)) continue;

      const cutoff = input.cutoffFor(deduction.skuId);

      // Sem corte, ou venda depois dele: nunca gravada e cancelada soma zero.
      if (cutoff === null || saleAt.getTime() > cutoff.capturedAt.getTime()) continue;
      // Cancelada até o corte: a planilha já tem a venda E a devolução.
      if (cancelledAt.getTime() <= cutoff.capturedAt.getTime()) continue;

      sales.push(deduction);
    }
  }

  const estornos: StockMovementDraft[] = [];

  for (const sale of [...input.recordedSales.map(comoRascunho), ...sales]) {
    if (input.estornadas.has(sale.idempotencyKey)) continue;

    const estorno = preCaptureEstornoOf(sale, saleAt, preCapture);

    if (estorno !== null) estornos.push(estorno);
  }

  const reversals = computeCancellationReversals(
    { id: input.order.id, status: input.order.status, occurredAt: input.occurredAt, occurredAtKnown: input.occurredAtKnown },
    [...input.recordedSales, ...sales],
    {
      estornadas: new Set([...input.estornadas, ...estornos.map((estorno) => estornadoKeyOf(estorno.idempotencyKey))]),
      cutoffFor: input.cutoffFor,
    },
  );

  return { sales, estornos, reversals };
}

function comoRascunho(sale: RecordedSaleMovement & RecordedSale): StockMovementDraft {
  return { skuId: sale.skuId, qtyDelta: sale.qtyDelta, idempotencyKey: sale.idempotencyKey, occurredAt: sale.occurredAt };
}
