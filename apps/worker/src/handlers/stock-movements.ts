import type { AdminClient } from "@sb/db";
import type { StockMovementDraft } from "@sb/domain";
import type { Logger } from "@sb/observability";

/**
 * Grava os rascunhos de dedução de estoque produzidos por
 * `computeSaleDeductions` (`@sb/domain/inventory`) em `stock_movements`.
 *
 * Best-effort DE PROPÓSITO, mesmo padrão de `domain-events.ts`: falhar aqui
 * não pode derrubar uma persistência de pedido que já deu certo. O
 * conflito de `idempotency_key` (23505) não é sequer logado como erro: é a
 * garantia física do ledger funcionando (docs/DATABASE.md secao 3) —
 * reprocessar o mesmo pedido não deduz o estoque duas vezes.
 */

const UNIQUE_VIOLATION = "23505";

export interface RecordStockMovementsContext {
  organizationId: string;
}

export async function recordStockMovements(
  db: AdminClient,
  context: RecordStockMovementsContext,
  drafts: readonly StockMovementDraft[],
  movementType: string,
  source: { type: string; id: string },
  logger: Logger,
): Promise<void> {
  for (const draft of drafts) {
    const result = await db.from("stock_movements").insert({
      organization_id: context.organizationId,
      sku_id: draft.skuId,
      location_kind: "LOCAL",
      qty_delta: draft.qtyDelta,
      movement_type: movementType,
      source_type: source.type,
      source_id: source.id,
      idempotency_key: draft.idempotencyKey,
      occurred_at: draft.occurredAt.toISOString(),
    });

    if (result.error !== null && result.error.code !== UNIQUE_VIOLATION) {
      logger.error("stock_movement_not_recorded", {
        sku_id: draft.skuId,
        idempotency_key: draft.idempotencyKey,
        reason: result.error.message,
      });
    }
  }
}
