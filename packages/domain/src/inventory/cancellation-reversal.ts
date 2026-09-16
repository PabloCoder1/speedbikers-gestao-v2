import { isCancelledOrderStatus } from "../events/order-events.js";
import { cancellationKeyOf, remainingToReverse } from "./reversal-limit.js";
import type { RecordedReversal, TimedRecordedReversal } from "./reversal-limit.js";
import {
  computeSaleDeductions,
  estornadoKeyOf,
  excessReversalEstornosOf,
  preCaptureEstornoOf,
  saleInstant,
} from "./sale-deduction.js";
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
 * **A reversão é limitada pelo que a devolução já devolveu** (verificação de
 * e6fda07, ALTA-1; `reversal-limit.ts`): cancelamento e devolução entregue
 * revertem a MESMA venda, e a unidade volta ao estoque no máximo uma vez. O
 * cancelamento grava só o que falta, e não grava nada quando a devolução já
 * devolveu a venda inteira.
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
 * "Corte", aqui, é a EXPORTAÇÃO da planilha (`ErpCutoff.exportedAt`): é ela que
 * diz o que a planilha tem (reverificação de c48fb70, MÉDIA-1).
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
  /** `CANCELAMENTO_ML` e `DEVOLUCAO_ML` já gravados do pedido: o limite de cada reversão. */
  readonly reversals: readonly RecordedReversal[];
}

interface CancellationReversalPlan {
  readonly reversals: StockMovementDraft[];
  /** Chaves de venda sem nada a reverter: a devolução (ou o legado) já devolveu tudo. */
  readonly alreadyReversed: string[];
}

/**
 * A planilha já contém o cancelamento desta venda: ela está estornada (a
 * planilha tem a venda) e o pedido cancelou, com instante conhecido, até a
 * EXPORTAÇÃO do corte do SKU (a planilha tem a unidade de volta). O cancelamento
 * não reverte, e a unidade já voltou ao estoque -- pela planilha.
 *
 * É a mesma pergunta nos dois lados da venda (reverificação de 60c7a6a,
 * BAIXA-1): o cancelamento pula por ela, e a devolução entregue depois trata a
 * venda como já revertida (`cancelledInSheetKeys`). Sem o segundo lado, o
 * cancelamento pulado não deixava rastro no ledger, e a devolução devolvia a
 * unidade uma segunda vez.
 */
export function sheetContainsCancellation(
  order: CancellationReversalOrder,
  sale: RecordedSaleMovement,
  estornadas: ReadonlySet<string>,
  cutoffFor: (skuId: string) => ErpCutoff | null,
): boolean {
  if (!isCancelledOrderStatus(order.status) || !order.occurredAtKnown || !estornadas.has(sale.idempotencyKey)) {
    return false;
  }

  const cutoff = cutoffFor(sale.skuId);

  return cutoff !== null && order.occurredAt.getTime() <= cutoff.exportedAt.getTime();
}

/**
 * As chaves das vendas do pedido cujo cancelamento a planilha já contém
 * (`sheetContainsCancellation`): a devolução entregue não as reverte de novo.
 * "Instante desconhecido" não entra -- o cancelamento dessas reverte, e o limite
 * das reversões gravadas cuida da devolução.
 */
export function cancelledInSheetKeys(
  order: CancellationReversalOrder,
  saleMovements: readonly RecordedSaleMovement[],
  estornadas: ReadonlySet<string>,
  cutoffFor: (skuId: string) => ErpCutoff | null,
): string[] {
  return saleMovements
    .filter((sale) => sheetContainsCancellation(order, sale, estornadas, cutoffFor))
    .map((sale) => sale.idempotencyKey);
}

function planCancellationReversals(
  order: CancellationReversalOrder,
  saleMovements: readonly RecordedSaleMovement[],
  preCapture: CancellationPreCapture,
): CancellationReversalPlan {
  const plan: CancellationReversalPlan = { reversals: [], alreadyReversed: [] };

  if (!isCancelledOrderStatus(order.status)) {
    return plan;
  }

  for (const movement of saleMovements) {
    // Estornada e cancelada até a exportação: a planilha já tem a venda E a devolução.
    if (sheetContainsCancellation(order, movement, preCapture.estornadas, preCapture.cutoffFor)) continue;

    const idempotencyKey = cancellationKeyOf(movement.idempotencyKey);
    const restante = remainingToReverse(movement, preCapture.reversals, idempotencyKey);

    if (restante <= 0) {
      plan.alreadyReversed.push(movement.idempotencyKey);
      continue;
    }

    plan.reversals.push({
      skuId: movement.skuId,
      qtyDelta: movement.qtyDelta < 0 ? restante : -restante,
      idempotencyKey,
      occurredAt: order.occurredAt,
    });
  }

  return plan;
}

export function computeCancellationReversals(
  order: CancellationReversalOrder,
  saleMovements: readonly RecordedSaleMovement[],
  preCapture: CancellationPreCapture,
): StockMovementDraft[] {
  return planCancellationReversals(order, saleMovements, preCapture).reversals;
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
  /** `CANCELAMENTO_ML` e `DEVOLUCAO_ML` já gravados do pedido, com o instante de cada um. */
  readonly reversals: readonly TimedRecordedReversal[];
  readonly cutoffFor: (skuId: string) => ErpCutoff | null;
}

export interface CancellationMovements {
  /** `VENDA_ML` que a V3 nunca gravou, de venda anterior ao corte e cancelada depois dele. */
  readonly sales: StockMovementDraft[];
  /** `ESTORNO_PRE_CAPTURA`: o par dessas vendas, e o que falta de venda já gravada. */
  readonly estornos: StockMovementDraft[];
  /**
   * `ESTORNO_REVERSAO_EXCEDENTE` (D-351 §12): a anulação da reversão a mais do legado
   * das vendas estornadas -- agora ou antes. Vem antes do cancelamento na gravação.
   */
  readonly excessReversalEstornos: StockMovementDraft[];
  /** `CANCELAMENTO_ML`. */
  readonly reversals: StockMovementDraft[];
  /** Chaves de venda que o cancelamento não reverteu porque a devolução já tinha devolvido tudo. */
  readonly alreadyReversed: string[];
}

/**
 * Tudo o que um pedido cancelado grava no ledger (D-351), na ordem de gravação:
 * venda, estorno, cancelamento.
 *
 * **A venda nunca gravada** (revisão de D-351, ALTA-2). Pedido pago antes da
 * planilha, sem vínculo na época, e cancelado depois dela: a planilha tem a
 * venda descontada e o UpSeller devolve a unidade depois — o estoque real é o
 * snapshot +1. Sem `VENDA_ML` gravado, `computeCancellationReversals` não teria
 * o que reverter, e a V3 ficaria 1 abaixo até a próxima planilha. Então grava
 * venda + estorno + cancelamento quando TODAS valem: o pedido não tem NENHUM
 * `VENDA_ML` gravado, a V3 viu a transição de venda para cancelado,
 * `date_closed` existe, a venda é até o corte do SKU, e o cancelamento tem
 * instante conhecido e POSTERIOR ao corte. Sem a transição observada,
 * "cancelado" pode ser da carga da história — os 9 pedidos que o backfill já
 * trouxe cancelados, antes da planilha, e que não mexem.
 *
 * **Nenhum `VENDA_ML` gravado, e não "a chave de hoje não foi gravada"**
 * (verificação de e6fda07, MÉDIA-1). A chave vem dos vínculos de HOJE: se a
 * composição do KIT mudou, ou o PRODUTO virou KIT, entre a venda e o
 * cancelamento, a chave de hoje não bate com a gravada e o trio reporia um SKU
 * que nunca foi baixado. Pedido com qualquer venda gravada só reverte o que foi
 * gravado (D-020).
 *
 * **O cancelamento do trio leva o instante que passou pela regra do corte**
 * (verificação de e6fda07, BAIXA-1): com o instante desta leitura desconhecido,
 * `date_created` cairia antes do corte, e o alvo não contaria a reposição que o
 * saldo contou.
 *
 * **O estorno que falta de venda já gravada** sai pela mesma regra da venda
 * (`preCaptureEstornoOf`). Sem ele, um retry que achasse a venda gravada e o
 * estorno não reverteria para zero em vez de +1.
 *
 * **A reversão a mais do legado** (D-351 §12): toda venda estornada -- agora ou
 * antes -- sai com a anulação do que o cancelamento E a devolução gravados
 * devolveram além dela (`excessReversalEstornosOf`), com o instante da reversão.
 */
export function computeCancellationMovements(input: CancellationMovementsInput): CancellationMovements {
  if (!isCancelledOrderStatus(input.order.status)) {
    return { sales: [], estornos: [], excessReversalEstornos: [], reversals: [], alreadyReversed: [] };
  }

  const saleAt = saleInstant(input.order);
  const gravadas = new Map(input.recordedSales.map((sale) => [sale.idempotencyKey, sale]));
  const preCapture: PreCaptureCutoffs = {
    cutoffFor: input.cutoffFor,
    recordedSale: (key) => gravadas.get(key),
    recordedReversals: input.reversals,
  };

  const sales: StockMovementDraft[] = [];
  const { transition } = input;
  const cancelledAt = transition?.cancelledAt ?? null;

  if (transition !== null && cancelledAt !== null && input.order.dateClosed !== null && input.recordedSales.length === 0) {
    // O status da transicao passa pelo filtro de venda valida de
    // `computeSaleDeductions`: `confirmed -> cancelled` nao gera rascunho nenhum.
    const { deductions } = computeSaleDeductions({ ...input.order, status: transition.saleStatus }, preCapture);

    for (const deduction of deductions) {
      const cutoff = input.cutoffFor(deduction.skuId);

      // O que a planilha tem é decidido pela EXPORTAÇÃO (`exportedAt`), e não pelo corte
      // do alvo: no snapshot que ainda carrega o parse, a venda entre a exportação e o
      // parse não está nela (reverificação de c48fb70, MÉDIA-1).
      // Sem corte, ou venda depois da exportação: nunca gravada e cancelada soma zero.
      if (cutoff === null || saleAt.getTime() > cutoff.exportedAt.getTime()) continue;
      // Cancelada até a exportação: a planilha já tem a venda E a devolução.
      if (cancelledAt.getTime() <= cutoff.exportedAt.getTime()) continue;

      sales.push(deduction);
    }
  }

  const estornos: StockMovementDraft[] = [];
  const excessReversalEstornos: StockMovementDraft[] = [];

  for (const sale of [...input.recordedSales.map(comoRascunho), ...sales]) {
    if (input.estornadas.has(sale.idempotencyKey)) {
      // Já estornada: a anulação da reversão a mais sai de novo (o UNIQUE a absorve). É o
      // que completa o webhook que gravou o estorno e falhou antes da anulação, e o excesso
      // que a corrida de duas reversões criou depois do estorno (D-351 §12).
      excessReversalEstornos.push(...excessReversalEstornosOf(sale, input.reversals));
      continue;
    }

    const estorno = preCaptureEstornoOf(sale, saleAt, preCapture);

    if (estorno !== null) {
      estornos.push(estorno);
      excessReversalEstornos.push(
        ...excessReversalEstornosOf(
          { skuId: estorno.skuId, qtyDelta: -estorno.qtyDelta, idempotencyKey: sale.idempotencyKey },
          input.reversals,
        ),
      );
    }
  }

  const reversaoPreCaptura: CancellationPreCapture = {
    // O estorno gerado AGORA conta como estornado: sem isso, a venda gravada sem
    // par e cancelada até o corte sairia com estorno E cancelamento (+1).
    estornadas: new Set([...input.estornadas, ...estornos.map((estorno) => estornadoKeyOf(estorno.idempotencyKey))]),
    cutoffFor: input.cutoffFor,
    reversals: input.reversals,
  };

  const deGravadas = planCancellationReversals(
    { id: input.order.id, status: input.order.status, occurredAt: input.occurredAt, occurredAtKnown: input.occurredAtKnown },
    input.recordedSales,
    reversaoPreCaptura,
  );

  // O trio só existe com `cancelledAt` conhecido e posterior ao corte (acima).
  const instanteDoTrio = input.occurredAtKnown || cancelledAt === null ? input.occurredAt : cancelledAt;
  const doTrio = planCancellationReversals(
    { id: input.order.id, status: input.order.status, occurredAt: instanteDoTrio, occurredAtKnown: true },
    sales,
    reversaoPreCaptura,
  );

  return {
    sales,
    estornos,
    excessReversalEstornos,
    reversals: [...deGravadas.reversals, ...doTrio.reversals],
    alreadyReversed: [...deGravadas.alreadyReversed, ...doTrio.alreadyReversed],
  };
}

function comoRascunho(sale: RecordedSaleMovement & RecordedSale): StockMovementDraft {
  return { skuId: sale.skuId, qtyDelta: sale.qtyDelta, idempotencyKey: sale.idempotencyKey, occurredAt: sale.occurredAt };
}
