/**
 * Dedução de estoque por venda — a peça pura de
 * `apps/worker/src/handlers/persist-order.ts`, chamada a cada order
 * persistida.
 *
 * D-019: a venda vira linha no ledger no momento em que o pedido é
 * persistido, não calculada na leitura. `docs/DATABASE.md` secao 4: venda
 * de SKU de kit gera movimentos dos COMPONENTES — o kit não tem saldo
 * próprio (`skus.kind = 'KIT'` não é `PRODUTO`).
 *
 * Reversão por cancelamento/devolução é o PRÓXIMO item do checklist da
 * Fase 4 (`docs/ROADMAP.md`), de propósito separado: esta função só deduz
 * na direção de venda confirmada, nunca reverte.
 */

export interface SaleDeductionItem {
  readonly position: number;
  readonly quantity: number;
  readonly skuId: string | null;
  /** `null` quando `skuId` também é `null` — item sem vínculo, nada a deduzir. */
  readonly skuKind: "PRODUTO" | "KIT" | null;
  /** Só relevante quando `skuKind === "KIT"`. */
  readonly components: readonly { componentSkuId: string; quantity: number }[];
}

export interface SaleDeductionOrder {
  readonly id: number;
  readonly status: string;
  /** `orders.date_last_updated` — quando a mudança aconteceu de verdade. */
  readonly occurredAt: Date;
  readonly items: readonly SaleDeductionItem[];
}

export interface StockMovementDraft {
  readonly skuId: string;
  /** Sempre negativo: dedução. */
  readonly qtyDelta: number;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
}

/**
 * Mesma semântica de "venda válida" já aprovada para métricas (D-050):
 * `paid` ou `partially_refunded`. A chave de idempotência NÃO inclui o
 * status — reprocessar o mesmo pedido em qualquer uma dessas duas
 * situações produz a MESMA chave, e o `UNIQUE` do banco absorve o reenvio
 * sem duplicar, sem precisar rastrear transição de status aqui (o mesmo
 * raciocínio que já livra `detectOrderStatusEvents` de guardar estado
 * entre chamadas).
 */
const VALID_SALE_STATUSES = new Set(["paid", "partially_refunded"]);

export function computeSaleDeductions(order: SaleDeductionOrder): StockMovementDraft[] {
  if (!VALID_SALE_STATUSES.has(order.status)) {
    return [];
  }

  const drafts: StockMovementDraft[] = [];

  for (const item of order.items) {
    if (item.skuId === null) {
      // Item ainda sem vínculo: nada a deduzir. Resolve sozinho quando o
      // vínculo nascer e a order for reprocessada (D-020, sku_id gravado
      // fresco a cada persistência).
      continue;
    }

    if (item.skuKind === "KIT") {
      for (const component of item.components) {
        drafts.push({
          skuId: component.componentSkuId,
          qtyDelta: -(item.quantity * component.quantity),
          idempotencyKey: `venda:${String(order.id)}:${String(item.position)}:${component.componentSkuId}`,
          occurredAt: order.occurredAt,
        });
      }

      continue;
    }

    drafts.push({
      skuId: item.skuId,
      qtyDelta: -item.quantity,
      idempotencyKey: `venda:${String(order.id)}:${String(item.position)}`,
      occurredAt: order.occurredAt,
    });
  }

  return drafts;
}
