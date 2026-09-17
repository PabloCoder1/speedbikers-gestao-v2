import { EVENT_SEVERITY } from "../events/catalog.js";
import type { DomainEventDraft } from "../events/order-events.js";
import type { RecordedSaleMovement } from "./cancellation-reversal.js";
import { remainingToReverse, returnKeyOf } from "./reversal-limit.js";
import type { TimedRecordedReversal } from "./reversal-limit.js";
import { fullEstornoOf, fullReversalEstornosOf, isFullLogistic } from "./sale-deduction.js";
import type { OrderLogisticType, StockMovementDraft } from "./sale-deduction.js";

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
 *
 * **D-352 — pedido entregue pelo Full não repõe a loja.** O produto devolvido
 * volta para o galpão do Mercado Livre, não para a prateleira daqui, e o saldo
 * LOCAL nunca perdeu a unidade: repor seria somar uma unidade que a loja não
 * tem. A devolução de pedido `fulfillment` sai sem `DEVOLUCAO_ML` — e, quando a
 * venda gravada ainda não tem par, com o `ESTORNO_FULL` que falta (R3). É o
 * mesmo desenho de `cancelamentoDoFull`, porque é a mesma pergunta: "esta
 * unidade era da loja?".
 */

export interface ReturnedOrderItem {
  readonly position: number;
  readonly totalQuantity: number;
  readonly returnQuantity: number;
}

/**
 * Um `VENDA_ML` gravado, com o instante dele: é o `occurred_at` que o
 * `ESTORNO_FULL` espelha (D-352). A devolução não precisava dele até aqui
 * porque só revertia com o instante da DEVOLUÇÃO.
 */
export interface ReturnedSaleMovement extends RecordedSaleMovement {
  /** `stock_movements.occurred_at` da venda. */
  readonly occurredAt: Date;
}

/** O pedido devolvido, com o sinal de logística que decide se o estoque da loja se mexe (D-352). */
export interface ReturnedOrder {
  readonly id: number;
  /** `orders.logistic_type` — só `fulfillment` é Full. */
  readonly logisticType: OrderLogisticType;
}

export interface ReturnReversal {
  readonly movements: readonly StockMovementDraft[];
  /**
   * `ESTORNO_FULL` (D-352): o par que falta às vendas gravadas de um pedido
   * entregue pelo Full. Vazio fora do Full.
   */
  readonly estornosFull: readonly StockMovementDraft[];
  /**
   * `ESTORNO_REVERSAO_EXCEDENTE`: num pedido do Full, a anulação de TODA
   * reversão já gravada das vendas devolvidas (`fullReversalEstornosOf`). Vazio
   * fora do Full — lá o excesso do legado é cuidado pelo caminho da venda.
   */
  readonly excessReversalEstornos: readonly StockMovementDraft[];
  /** `false` = devolução parcial, nenhum movimento gerado — ver nota acima. */
  readonly fullReversal: boolean;
  /**
   * Chaves de venda que a devolução NÃO reverteu porque o cancelamento (ou
   * outra devolução) já tinha devolvido a venda inteira (`reversal-limit.ts`).
   */
  readonly alreadyReversed: readonly string[];
  readonly event: DomainEventDraft;
}

/**
 * **Limitada pelo que já foi revertido** (verificação de e6fda07, ALTA-1).
 * Cancelamento e devolução revertem a MESMA venda, e a unidade volta ao estoque
 * no máximo uma vez: a devolução grava só o que o cancelamento (ou outra
 * devolução) ainda não devolveu, e nada quando já devolveram tudo. É o que
 * impede o +2 dos pedidos que cancelam e depois têm a devolução entregue — no
 * Dev, 358 das 563 vendas com as duas reversões tiveram o cancelamento primeiro.
 *
 * **O cancelamento que a planilha já contém também conta** (reverificação de
 * 60c7a6a, BAIXA-1). A venda estornada cancelada até a exportação não grava
 * `CANCELAMENTO_ML` -- a planilha já tem a unidade de volta --, e sem nada
 * gravado a devolução entregue depois a devolveria uma segunda vez. As chaves
 * dessas vendas (`cancelledInSheetKeys`) saem com restante zero.
 */
export function computeReturnReversal(
  order: ReturnedOrder,
  item: ReturnedOrderItem,
  saleMovements: readonly ReturnedSaleMovement[],
  /** `CANCELAMENTO_ML` e `DEVOLUCAO_ML` já gravados do pedido, com o instante de cada um. */
  reversals: readonly TimedRecordedReversal[],
  claimId: string,
  occurredAt: Date,
  /** Chaves de venda cujo cancelamento a planilha já contém (`cancelledInSheetKeys`). */
  cancelledInSheet: ReadonlySet<string> = new Set(),
  /** Chaves de `VENDA_ML` que já têm estorno gravado (`ESTORNO_PRE_CAPTURA` ou `ESTORNO_FULL`). */
  estornadas: ReadonlySet<string> = new Set(),
): ReturnReversal {
  const prefix = `venda:${String(order.id)}:${String(item.position)}`;
  const matched = saleMovements.filter(
    (m) => m.idempotencyKey === prefix || m.idempotencyKey.startsWith(`${prefix}:`),
  );

  const doFull = isFullLogistic(order.logisticType);
  const fullReversal = item.returnQuantity >= item.totalQuantity && matched.length > 0;

  const movements: StockMovementDraft[] = [];
  const estornosFull: StockMovementDraft[] = [];
  const excessReversalEstornos: StockMovementDraft[] = [];
  const alreadyReversed: string[] = [];

  if (doFull) {
    // D-352, R3 — pedido entregue pelo Full: a devolução NÃO repõe a loja, em
    // devolução inteira ou parcial. O produto volta para o galpão do Mercado
    // Livre, não para a prateleira daqui, e o saldo LOCAL nunca perdeu a
    // unidade. O que sai é o par que faltava à venda e a anulação do que o
    // legado já devolveu — a mesma saída de `cancelamentoDoFull`, pela mesma
    // razão, e com as mesmas chaves (o `UNIQUE` absorve a repetição entre os
    // dois caminhos).
    for (const m of matched) {
      if (!estornadas.has(m.idempotencyKey)) {
        estornosFull.push(fullEstornoOf(m));
      }

      excessReversalEstornos.push(...fullReversalEstornosOf(m, reversals));
    }
  } else if (fullReversal) {
    for (const m of matched) {
      const idempotencyKey = returnKeyOf(claimId, m.idempotencyKey);
      // A planilha já contém o cancelamento desta venda: a unidade já voltou, sem linha no ledger.
      const restante = cancelledInSheet.has(m.idempotencyKey) ? 0 : remainingToReverse(m, reversals, idempotencyKey);

      if (restante <= 0) {
        alreadyReversed.push(m.idempotencyKey);
        continue;
      }

      movements.push({ skuId: m.skuId, qtyDelta: m.qtyDelta < 0 ? restante : -restante, idempotencyKey, occurredAt });
    }
  }

  const eventType = "order.returned";

  return {
    movements,
    estornosFull,
    excessReversalEstornos,
    fullReversal,
    alreadyReversed,
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
        // A devolução inteira que não moveu o saldo porque o cancelamento já
        // tinha devolvido a unidade: registrado, não silencioso.
        movementsAlreadyReversed: alreadyReversed.length,
        // D-352: a devolução de pedido do Full, e quantos pares faltavam à venda.
        // Sem isso, o evento diria "0 movimentos revertidos" sem dizer por quê —
        // indistinguível do caso em que o cancelamento já tinha devolvido tudo.
        fullLogistic: doFull,
        movementsEstornoFull: estornosFull.length,
        // Devolução parcial de pedido do Full não pede gente: não há nada a
        // ajustar no saldo da loja, que nunca perdeu a unidade. A revisão manual
        // existe para a fração de KIT que a V3 não sabe arredondar, e essa
        // pergunta só nasce quando a reposição é de verdade.
        needsManualReview: !fullReversal && !doFull,
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
